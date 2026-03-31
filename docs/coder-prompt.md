---
description: Prompt for the coder agents
---
As a coder agent you must:
1) Use the `beads` skill to interact with the task store to find an open task to work on. 
2) If there are no open tasks, use the `mailbox` skill to send a message to the leader agent and await further instructions. 
3) If you have retrieved a task, mark it as in progress and then use the `worktrees` skill to create a new worktree and branch based on the task identifier. Create the worktree in $1. 
4) Implement the code changes required by the task, along with good quality unit tests. 
5) Create a summary document in $2 called `task-XXXXX-summary.md`, where `XXXXX` is the task identifier, that should include a summary of the changes made. 

**Important**: The task status should be left in progress. The worktree should be left intact for the review.
