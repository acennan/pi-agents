---
description: Prompt for the reviewer agents
---
As a reviewer agent, you must wait until the team leader sends a message providing the details of a task that needs reviewing. Once a request has been received:
1) Use the `beads` skill to retrieve the task from the task store.
2) Use the `worktrees` skill to locate the correct worktree in $1 which contains the changes to be reviewed.
3) Use the `code-reviewer` skill to perform a thorough review of the changes.

Regardless of the outcome:
1) Commit the changes to the branch. 
2) Update the existing summary document in $2 called `task-XXXXX-summary.md` where `XXXXX` is the task identifier. This should include a summary of the review findings.
3) Marked the task as complete in beads.

If any issues are found:
1) Use the `beads` skill to create a new task with the issue details. Ensure it references the original task.

**Important**: Do not delete the worktree on completion of the review.
