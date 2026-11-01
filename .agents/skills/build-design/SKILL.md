---
name: build-design
description: Builds UI from a Figma file or a design image so it matches the design, using the project's existing tokens and components.
---

# Build design

This skill turns a design into code that matches it. It reads the design at its source, builds with what the project already has, then compares the result against the design before calling it done.

The design decides. Values come from the design file, never from your taste or a pattern you liked elsewhere. Resolve ordinary implementation choices from project conventions. Ask only for a material product or design deviation not settled by existing authority.

It owns no domain rules. Where the design conflicts with required domain rules, resolve the conflict using the owning skill and existing authority. A material fidelity decision only the user can make remains pending; do not ship a known required-rule violation. Contrast is a requirement in `better-accessibility` and a measurement in `better-colors`. Focus and semantics are `better-accessibility`, type is `better-typography` and spacing and structure are `better-layout`. Palette is `better-colors`, copy is `better-writing` and surfaces, icons and motion are `better-ui`. Reviewing finished work is `interface-review`, exploring alternatives is `variant` and stress testing a component is `break`.

## 1. Read the design at its source

A Figma link means the Figma MCP. Search the available and deferred tools for `figma` before saying it is unavailable, since the server often sits under a name you did not expect. A server that lists only an authenticate tool is connected but signed out, so ask the user to authenticate. With no Figma tool at all, ask the user to connect one, and do not build from memory or guesswork meanwhile. [figma.md](figma.md) holds which tools to call and what each returns.

A screenshot or exported image has no values to read. Sizes are ratios to the capture, so state the scale you assumed and treat every measurement as an estimate. Ask for the Figma link when one exists, since it replaces the whole estimate.

Scope the run to the frames named. Frames that show the same thing at different widths are one piece at several breakpoints, not separate pieces.

This step is done when you hold a screenshot of every frame in scope and its values for spacing, size, radius, color, type and the components used. From a Figma file they are exact. From an image they are estimates at the scale you stated.

## 2. Map the design onto the project

Read the project's tokens and component library before writing anything. Then map every design value to what exists:

| In the design | In code |
| --- | --- |
| A bound variable or style | The token with the same name or the same value |
| A raw value that equals a token | That token |
| A raw value with no token | An exact scoped value permitted by project rules; round only when it meets the requested fidelity |
| A component instance | The project's component of that name, with the variant the design shows |
| A component instance with no project equivalent | Use the smallest implementation consistent with project conventions; create a reusable component only when the requested behavior warrants one |
| A one-off group of layers | Plain markup in place, not a new component |

Reuse matching tokens and components. When none matches, use a narrowly scoped value or component consistent with project rules and the supplied design. Resolve ordinary mapping choices from evidence; ask only for a material unresolved design decision or a prohibited exception.

Wire the data and behavior required by the request. If backend work is authorized, complete that integration. For an explicitly visual-only or mock-only task, use props and clearly identify the boundary. Missing required wiring is incomplete work, not a completed UI.

## 3. Build the requested design and behavior

Implement the requested frames, breakpoints, and states. Reuse existing component defaults for unspecified states. If the requested functioning flow needs additional loading, empty, or error behavior, implement it consistently with the project; ask only for a material unresolved product decision.

Keep changes within the requested outcome, including required data wiring and functional states. Preserve unrelated work and avoid neighboring copy, icon, or cleanup changes not needed by the task.

## 4. Compare against the design

Render the build at each frame's width beside the design screenshot and walk it element by element. Compare the properties **Read the design at its source** collected. "Gap is 12px, design is 16px" is a finding. "Feels a bit tight" is not.

Discover and use available authorized browser tools to compare each required width. Fix harness issues and recheck affected comparisons. Preserve project-specific Chrome crash and access restrictions. A genuine blocker leaves comparison unverified; do not report a match you did not inspect.

Fix mismatches and compare again. Completion requires every requested behavior and design decision to be resolved and verified. Report any real blocker and unfinished outcome; an open question is not completion evidence.

## 5. Report verified completion or a concrete blocker

| Element | Design | Built | Status |
| --- | --- | --- | --- |
| Card padding | 20px | `p-5` | Matches |
| Title size | 15px | Scoped 15px value | Matches |
| Badge | Filled pill | Filled pill using existing primitives | Matches |

Then list, one line each, and omit a list with nothing in it:

- **Unwired.** Only integrations explicitly outside the requested scope; required missing integrations remain blockers.
- **Missing states.** Unspecified states covered by project defaults, or required states blocked by a specific missing decision.
- **Domain conflicts.** Where the design breaks a rule, with the owning skill.

Close by saying where the build is running and at which widths you compared.

## Before you finish

| You notice | Fix |
| --- | --- |
| "Figma isn't connected" written before any tool search | Search the tools for `figma` first |
| Values in code that appear in no Figma response, only in the screenshot | Read them from the design context |
| An arbitrary utility such as `w-[343px]` or a raw hex in the diff | Use a matching token or a narrow project-permitted value; resolve any material design conflict |
| A new file under the components directory for a frame that is not a component | Inline it as plain markup |
| A loading or error branch the design never drew | Keep required functional states and use project conventions; omit only behavior outside the request |
| Task-owned files changed beyond the requested outcome | Remove only those out-of-scope edits; retain required integration and preserve unrelated work |
| Required contrast or focus conflicts with the design | Resolve it with the owning skill; ask only for a material unresolved fidelity choice, and keep the task incomplete until resolved |
| A comparison claimed with no screenshot of the build | Render each frame width, or say it is unverified |
| Hard-coded sample data with no mention in the report | Complete required data wiring, or identify an explicitly mock-only boundary |
