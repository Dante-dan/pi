# Windows process ownership

`pi-process-job.exe` launches a shell in a Windows Job Object before it runs.
Timeout, abort and parent exit terminate the job and wait up to five seconds for
its active-process count to reach zero. This includes MSYS2 pipeline processes
whose intermediate parent exited before cancellation (issue #9129).

Normal shell exit releases the job's kill-on-close limit, preserving intentional
background children and the existing post-exit output draining behavior. Commands
that already completed normally are not retroactively cancelled. POSIX execution
continues using process groups.

The helper requires Windows 10 or newer. It uses `PROC_THREAD_ATTRIBUTE_JOB_LIST`
instead of spawning and then assigning a running process, which leaves a race.
Job handles are not inherited. Only duplicated standard stream handles are passed
to the shell, with its original command line, environment and working directory.
The randomly named cancellation event supports cancellation before shell startup.
The helper does not perform PID-tree enumeration or kill by executable name.

Build the checked-in x64 and arm64 prebuilds with LLVM-MinGW:

```sh
CC_X64=/path/to/x86_64-w64-mingw32-clang \
CC_ARM64=/path/to/aarch64-w64-mingw32-clang \
node packages/agent/native/win32/build.mjs
```

Native binaries are included in the agent npm package and copied beside the
standalone Windows executable. A missing helper is an execution error; there is
no silent fallback to `taskkill /T`, which cannot provide this ownership guarantee.

Sources: [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects),
[creation-time assignment](https://devblogs.microsoft.com/oldnewthing/20230209-00/?p=107812).
