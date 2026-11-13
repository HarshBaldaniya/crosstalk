---
name: tests
title: Write tests
pack: engineering
description: Write the tests a change needs, at the right level, using the project's own test tools and patterns.
args: target = Code or change to test (default: what this branch changed); level = unit, integration or end-to-end (default: pick per risk)
triggers: write tests, add tests, test this, test plan, test strategy, unit tests, e2e tests, integration tests, coverage
---
Write tests for {{target}} (level: {{level}}).

1. **Find the patterns:** the test runner and an existing test next to the code (`crosstalk_map` with outline on the folder). Copy their style, helpers and fixtures; add no new test library.
2. **Pick the level by risk:** pure logic → unit; code that crosses a boundary (database, API, queue) → integration; a user journey that must never break (sign-in, payment, save) → end-to-end. Prefer the lowest level that would catch the bug.
3. **Cases, before code:** list them as one line each: the happy path, each edge (empty, max, invalid, duplicate, concurrent), each error path, and the bug that prompted this (if any) as a regression test.
4. **Write them:** one behaviour per test, named for what it proves ("refuses a second charge for the same invoice"). No sleeps for timing; wait on a real condition. Never touch real user data, settings or services; use temp folders and fakes.
5. **Run them.** Show the result. A test that fails for a reason you didn't expect is a finding: report it, don't silence it.
