// Command-scoped ownership for Windows shell descendants (pi issue #9129).
// Requires Windows 10: JOB_LIST assigns the process before it can run.
#define _WIN32_WINNT 0x0A00
#ifndef UNICODE
#define UNICODE 1
#endif
#ifndef _UNICODE
#define _UNICODE 1
#endif
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <wchar.h>

#ifndef PROC_THREAD_ATTRIBUTE_JOB_LIST
#define PROC_THREAD_ATTRIBUTE_JOB_LIST ProcThreadAttributeValue(13, FALSE, TRUE, FALSE)
#endif

#define CLEANUP_FAILURE 125
#define CLEANUP_TIMEOUT_MS 5000

static int failure(const char *operation) {
    fprintf(stderr, "pi process job: %s failed (Windows error %lu)\n", operation, GetLastError());
    return CLEANUP_FAILURE;
}

static int terminate_job(HANDLE job) {
    if (!TerminateJobObject(job, 1)) return failure("TerminateJobObject");
    ULONGLONG deadline = GetTickCount64() + CLEANUP_TIMEOUT_MS;
    for (;;) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = {0};
        if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof(info), NULL)) {
            return failure("QueryInformationJobObject");
        }
        if (info.ActiveProcesses == 0) return 0;
        if (GetTickCount64() >= deadline) {
            SetLastError(ERROR_TIMEOUT);
            return failure("waiting for job processes to exit");
        }
        Sleep(10);
    }
}

// Node already escaped the command and arguments for CreateProcess. Remove only
// our four launcher arguments, preserving the command's exact quoting.
static wchar_t *command_line(void) {
    wchar_t *cursor = GetCommandLineW();
    for (int index = 0; index < 4; index++) {
        while (*cursor == L' ' || *cursor == L'\t') cursor++;
        int quoted = 0;
        while (*cursor && (quoted || (*cursor != L' ' && *cursor != L'\t'))) {
            if (*cursor == L'"') quoted = !quoted;
            cursor++;
        }
    }
    while (*cursor == L' ' || *cursor == L'\t') cursor++;
    return cursor;
}

static int cancel(HANDLE event, DWORD launcher_pid) {
    HANDLE launcher = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, launcher_pid);
    if (!launcher) {
        if (GetLastError() == ERROR_INVALID_PARAMETER) return 0;
        return failure("OpenProcess launcher");
    }
    if (!SetEvent(event)) {
        CloseHandle(launcher);
        return failure("SetEvent cancellation");
    }
    // Retain the event even if cancellation arrived before launcher startup.
    DWORD result = WaitForSingleObject(launcher, CLEANUP_TIMEOUT_MS + 5000);
    DWORD exit_code = 0;
    if (result == WAIT_OBJECT_0 && !GetExitCodeProcess(launcher, &exit_code)) {
        CloseHandle(launcher);
        return failure("GetExitCodeProcess launcher");
    }
    CloseHandle(launcher);
    if (result == WAIT_OBJECT_0) {
        if (exit_code == CLEANUP_FAILURE) {
            fprintf(stderr, "pi process job: launcher reported a cleanup or startup failure\n");
            return CLEANUP_FAILURE;
        }
        return 0;
    }
    if (result == WAIT_TIMEOUT) SetLastError(ERROR_TIMEOUT);
    return failure("waiting for launcher cancellation");
}

static int run(HANDLE cancellation, DWORD parent_pid, wchar_t *application) {
    HANDLE parent = OpenProcess(SYNCHRONIZE, FALSE, parent_pid);
    if (!parent) return failure("OpenProcess parent");
    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (!job) {
        CloseHandle(parent);
        return failure("CreateJobObject");
    }
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {0};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    int result = CLEANUP_FAILURE;
    STARTUPINFOEXW startup = {0};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    SIZE_T attribute_size = 0;
    HANDLE streams[3] = {0};
    HANDLE source_streams[3] = {GetStdHandle(STD_INPUT_HANDLE), GetStdHandle(STD_OUTPUT_HANDLE), GetStdHandle(STD_ERROR_HANDLE)};
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
        result = failure("SetInformationJobObject");
        goto cleanup;
    }
    for (int index = 0; index < 3; index++) {
        if (!DuplicateHandle(GetCurrentProcess(), source_streams[index], GetCurrentProcess(), &streams[index], 0, TRUE, DUPLICATE_SAME_ACCESS)) {
            result = failure("DuplicateHandle stdio");
            goto cleanup;
        }
    }
    startup.StartupInfo.hStdInput = streams[0];
    startup.StartupInfo.hStdOutput = streams[1];
    startup.StartupInfo.hStdError = streams[2];
    InitializeProcThreadAttributeList(NULL, 2, 0, &attribute_size);
    startup.lpAttributeList = HeapAlloc(GetProcessHeap(), 0, attribute_size);
    if (!startup.lpAttributeList || !InitializeProcThreadAttributeList(startup.lpAttributeList, 2, 0, &attribute_size)) {
        result = failure("InitializeProcThreadAttributeList");
        if (startup.lpAttributeList) HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
        startup.lpAttributeList = NULL;
        goto cleanup;
    }
    if (!UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job, sizeof(job), NULL, NULL) ||
        !UpdateProcThreadAttribute(startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, streams, sizeof(streams), NULL, NULL)) {
        result = failure("UpdateProcThreadAttribute");
        goto cleanup;
    }
    if (WaitForSingleObject(parent, 0) == WAIT_OBJECT_0 || WaitForSingleObject(cancellation, 0) == WAIT_OBJECT_0) {
        result = 1;
        goto cleanup;
    }
    PROCESS_INFORMATION process = {0};
    if (!CreateProcessW(application, command_line(), NULL, NULL, TRUE,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, NULL, NULL, &startup.StartupInfo, &process)) {
        result = failure("CreateProcess in job");
        goto cleanup;
    }
    CloseHandle(process.hThread);
    for (int index = 0; index < 3; index++) {
        CloseHandle(streams[index]);
        streams[index] = NULL;
    }
    HANDLE waits[3] = {parent, cancellation, process.hProcess};
    DWORD signaled = WaitForMultipleObjects(3, waits, FALSE, INFINITE);
    if (signaled == WAIT_OBJECT_0 + 2 && WaitForSingleObject(parent, 0) != WAIT_OBJECT_0 &&
            WaitForSingleObject(cancellation, 0) != WAIT_OBJECT_0) {
        DWORD exit_code = 0;
        if (!GetExitCodeProcess(process.hProcess, &exit_code)) {
            result = failure("GetExitCodeProcess");
        } else {
            // Preserve intentional background children after normal shell exit.
            // Timeout/abort/parent death take the termination branch instead.
            limits.BasicLimitInformation.LimitFlags = 0;
            result = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))
                ? (int)exit_code : failure("releasing completed job");
        }
    } else {
        int cleanup_result = terminate_job(job);
        result = cleanup_result == 0 ? 1 : cleanup_result;
    }
    CloseHandle(process.hProcess);
cleanup:
    if (startup.lpAttributeList) {
        DeleteProcThreadAttributeList(startup.lpAttributeList);
        HeapFree(GetProcessHeap(), 0, startup.lpAttributeList);
    }
    for (int index = 0; index < 3; index++) if (streams[index]) CloseHandle(streams[index]);
    CloseHandle(job);
    CloseHandle(parent);
    return result;
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 4 || wcslen(argv[2]) != 36) return CLEANUP_FAILURE;
    wchar_t event_name[80];
    if (swprintf(event_name, 80, L"Local\\pi-process-%ls", argv[2]) < 0) return CLEANUP_FAILURE;
    wchar_t *end = NULL;
    unsigned long pid = wcstoul(argv[3], &end, 10);
    if (!pid || !end || *end) return CLEANUP_FAILURE;
    HANDLE event = CreateEventW(NULL, TRUE, FALSE, event_name);
    if (!event) return failure("CreateEvent");
    int result = CLEANUP_FAILURE;
    if (wcscmp(argv[1], L"--cancel") == 0) result = cancel(event, (DWORD)pid);
    else if (wcscmp(argv[1], L"--run") == 0 && argc >= 5) result = run(event, (DWORD)pid, argv[4]);
    CloseHandle(event);
    return result;
}
