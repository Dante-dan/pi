# Agent-driven compaction

Load with `pi -e ./examples/extensions/compact-and-continue.ts`. The extension
registers an opt-in `compact` tool with `{ "continue": true, "instructions": "..." }`.
For example, ask the agent to address each review comment, commit the result, and
call `compact` between comments. It must call this tool alone in a turn.

The tool summarizes the current projected conversation using the active model.
After its successful tool result is persisted, `turn_end` commits a compaction
entry and requests a next turn. That turn sees the summary without an additional
user prompt. Raw session history stays in the transcript, but no old messages are
retained in model context. The summary must preserve the remaining task.

An empty, truncated or failed summary returns a tool error; the agent can handle
the error in its original context. No compaction or explicit boundary continuation
is committed on that path. User cancellation discards the pending summary and
does not start another turn. A turn containing another tool result also discards
the pending summary because that tool may have changed state after the snapshot.

This is a separate extension example, not a change to `/compact` or prompt queue
ordering. It uses a full-context handoff rather than the built-in retained-tail
compaction policy. It does not invoke `session_before_compact`, manual compaction
events, compaction model overrides or virtual summarization routing. Those paths
remain unchanged. The summary request uses the active model through ModelRegistry
with caching disabled and a maximum of 8192 output tokens (bounded by model limits).
There is no automatic retry on a summary error; calling the tool again is an
explicit agent decision. Summarization has the usual model cost and lossy-summary
limitations. The example can be removed by unloading it.
