# @gitorch/github-sync

GitHub Sync is the F5 package for GitOrch.

It treats GitHub as the canonical operating system for work:

- issue types classify work as Epic, Feature, Task, Bug, Security, or Improvement;
- sub-issues express hierarchy such as Epic -> Feature -> Task;
- issue dependencies express execution gates such as Task 6 blocked by Task 3;
- Projects V2 fields expose status, priority, owner agent, phase, risk, severity, effort, iteration, linked PRs, parent issue, and sub-issue progress;
- webhooks feed GitHub changes into Synapse;
- GraphQL mutations apply GitOrch decisions back into GitHub.

This package does not run autonomous agents. It maps GitHub-native state into deterministic sync events and coordination signals.
