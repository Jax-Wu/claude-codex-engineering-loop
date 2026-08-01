# Planning Contract

Write a plan that Codex can execute and Claude can review.

Include:

1. goal and non-goals;
2. repository observations and applicable conventions;
3. design decisions and rejected alternatives;
4. expected modules/files;
5. behavior, API, and data compatibility;
6. error, concurrency, security, and rollback considerations;
7. ordered implementation steps;
8. acceptance criteria with stable IDs;
9. tests and deterministic gates;
10. unresolved questions requiring a person.

Acceptance criteria must describe observable behavior, not implementation activity. Prefer “AC-002: concurrent refresh-token reuse yields one success and one rejection” over “add concurrency handling.”

Do not claim a file or API exists without inspecting the repository. Do not silently resolve a product decision.
