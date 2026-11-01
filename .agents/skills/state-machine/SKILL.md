---
name: state-machine
description: Renders every state of a component you choose on a throwaway page, with mock data and a switcher, so you can work on each state.
disable-model-invocation: true
---

# State machine

This skill takes one component and renders it on a throwaway page in every state it can be in. Mock data feeds each state, a switcher flips between them and the page is deleted in one step when you are done.

It is a workbench, not a review. The page stays up while the user works on the visuals, one state on screen and every other a keypress away. Stacking hostile scenarios on one page for a single look is `break`, exploring alternative designs is `variant` and reviewing finished work is `interface-review`.

## 1. Scope one component

Use one workbench per component. If the user requests several components, enumerate and complete each. Ask only when the intended scope remains unclear.

Restate it in one sentence: what the component shows, where it renders in production and where its data comes from.

## 2. Find the states in the code

The states are the branches the component already has. Read it and its data hooks for every one:

| Kind | States |
| --- | --- |
| Data | Loading, empty, error, one item, a typical set, a set long enough to scroll or paginate, some requests resolved and others pending, stale data refetching |
| Account | Plan tier, role and permission checks, an owner versus a member |
| Feature | Flags, trials, limits reached, a disabled or locked feature |

The harness covers states the code can reach. Do not invent branches just for the harness. If the task also requests a missing product state, implement and verify that state under the application workflow, then add it to the workbench.

Write the set down before building, one line each, named the way the product talks about it: `empty`, `enterprise`, `member-no-access`. Group them under headings in the product's words, by what changes. Use `Data` and `Account` or narrower ones such as `Connection` or `Access`. The switcher shows these groups. Say which kinds you dropped and why in one line. Combine kinds only where the code branches on the combination, such as `member-empty`, never as a cross product.

## 3. Build the throwaway page

A scratch route imports the real component. Do not change production behavior just to fake a fixture state; a minimal authorized data seam or separately requested product fix may be needed. The route inherits the app's layout, fonts, global styles and providers for free.

Where the framework splits server from client components, the page is client code, `"use client"` in Next. Otherwise fixture data can silently vanish crossing that boundary, and the page renders empty.

Render one instance in a container as wide as the component is in production. The container, the fixtures and the switcher are everything the page adds, with no fonts, styles or themes of its own. Keep the page, its fixtures and its switcher in one folder, such as `/states/audit-log`, so removal is one delete.

## 4. Feed each state at the data boundary

Prefer supplying data where the component already receives it, without changing production behavior. In order of preference:

1. Props, where the component takes its data as props.
2. The app's own data seam: a seeded query cache, a mock provider or the project's request mocks.

A fixture threaded through props five levels down tests a path production never takes. Use an existing seam first. If none works, add the smallest fixture seam within existing authority; ask only if it changes the public contract or exceeds the requested scope.

Make the data look like the product. Real-shaped names, timestamps, amounts and the item counts users actually have. Three rows of "Test item" make every state look fine.

Loading and pending states hold still. Keep them pending until the switcher moves, rather than resolving after a timeout.

## 5. Add the switcher

A grouped list beside the component flips the `__state` search param, so every state is a link. Where there is no room beside the component, it moves above it as a select with the same groups. The double underscore keeps it clear of any param the app's layout reads. [switcher.md](switcher.md) holds the spec.

## 6. Confirm every state renders, then hand over

Discover and use available authorized browser tools to load the page and flip through every state. The component shows the mock data, not the real data and not a blank region. Mock data that never appears is the common failure here. Live sync, a cache that refetches over the seed or a server boundary dropping the fixture all cause it. Fix the plumbing before handing over.

Inspect available authorized browser tools before declaring verification unavailable. Repair harness plumbing and recheck affected states. Preserve project-specific Chrome crash and access restrictions; a genuine blocker leaves verification incomplete.

For a harness-only request, deliver the URL, state list, and switcher keys. If the request already includes UI fixes, continue through those fixes and recheck every affected state before completion.

## Re-check every state after each change

After a visual change, flip through every state again, since a fix for one state often breaks another.

## Remove it in one step, on the user's word

When cleanup is requested, delete the page folder and its task-owned fixture seam without removing production behavior. Then search the codebase for the route and fixture names, and check that the diff touches nothing else of the setup.

## Before you finish

| Mistake | Fix |
| --- | --- |
| The component edited to accept fixtures | Feed data from the page through props or the app's data seam; add a minimal authorized seam only if existing seams cannot work |
| A rebuilt lookalike component on the page | Import the real component from the project |
| The page restyles or re-themes the component | The app's layout, fonts and tokens as they are |
| Fixtures passed as props deep in the tree | Supply the data where the component receives it |
| A branch added to the component to show a state | Do not invent harness-only states; implement requested missing product states before adding their fixtures |
| "Item 1", "Test user", three rows | Product-shaped data in real quantities |
| Loading resolves after a timeout | Hold it until the switcher moves |
| Handed over without loading each state | Load every state; a blank or real-data state means broken plumbing |
| Switcher styled with the project's tokens | Keep it visibly outside the design system |
| One long row of tabs, one per state | A grouped list beside the component that scrolls on its own; a select above it where the list does not fit |
| Visuals changed unasked | Hand over and wait |
| Page deleted in the same turn it was built | Remove it only on the user's word |
| Route or fixture names left behind | Search for both after removal |
