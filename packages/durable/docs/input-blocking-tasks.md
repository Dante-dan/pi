# Input-blocking tasks

A task's `background` option controls ownership traversal: ordinary conversation
aborts and idle waits do not reach a background task. It does not control whether
new submissions may start a generation.

`blocksInput: true` independently keeps the task's conversation busy for submission
admission until the task becomes terminal. For example, a checkpoint task created
after a run can use:

```ts
await tx.createTask(CheckpointTask, input, {
	ownership: { kind: "conversation" },
	background: true,
	blocksInput: true,
});
```

Ordinary `Conversation.abort()` leaves this background task running. Explicit
`abortTask()` or `abort(context, { background: true })` can still cancel it. The
existing idle-wait behavior is unchanged: await this task's receipt when its
completion matters. Manual compaction can remain a non-background task without
`blocksInput`, so it stays abortable without preventing a new run.

Clients can display busy state when `live.run` is present or
`live.blockingTasks` is nonempty. Submission admission uses the same rule, so
`whenBusy: "reject"` rejects and other inputs wait in the inbox. Boundaries leave
queued input and model-visible writes untouched until all blockers settle.
Display-only writes may still be appended. The last blocker's completion drains
the idle conversation's inbox; reopening also recovers a drain interrupted after
the task settled.

This option does not stop a generation already in progress. Create a checkpoint
at the appropriate end-of-run boundary; the lifecycle hook proposed in #11141 is
separate from this option. It also does not serialize other conversations or
other processes writing the same repository. A host that shares a working tree
across conversations still needs a repository lock.
