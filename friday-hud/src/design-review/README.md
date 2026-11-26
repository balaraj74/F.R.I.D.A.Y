# Design review gallery

A self-contained React component for reviewing the Reference_Images made by `friday design refs`
(Requirements 1.8 to 1.10). It is not mounted anywhere yet: HUD wiring waits for the migration
gate (Requirement 4.9).

## Styling predates tokens

`design-review.css` uses plain neutral values (hex colours, px sizes) on purpose. The design
tokens do not exist until the Design_Spec and Token_File are done. `pnpm design:lint` will flag
these as Off_System_Values. When the HUD migration happens, either move this directory onto the
generated tokens or leave it out of the migrated surfaces, and keep it out of the lint baseline
until then.

## Mounting

```tsx
import { DesignReviewGallery } from './design-review';

<DesignReviewGallery
  manifest={manifest}                    // parsed manifest.json
  initialSelection={selection}           // optional, parsed selection.json
  persistSelection={(file) => api.writeSelection(file)}
  resolveImageSrc={(entry) => `/api/media?path=${encodeURIComponent(entry.path ?? '')}`}
/>
```

- `persistSelection` receives the whole `SelectionFile` and must write it to `selection.json`.
  The host should back it with a gateway call that runs `writeSelection` from
  `src/design/refs/selection.ts`, so the 500-character check and the atomic write are shared.
  It should reject on failure; the card then shows the error.
- `resolveImageSrc` defaults to the manifest `path`. The Vite `/api/media` endpoint only serves
  generated-media paths, so the reference directory may need to be allowed there.
- Loading `manifest.json` and `selection.json` is the host's job.

## Behaviour

- Entries are grouped by Screen, then Style_Direction (`group.ts`, same semantics as
  `groupForGallery` in `src/design/refs/plan.ts`). `pending` entries are not shown.
- A `failed` entry (or a `created` entry with no path) shows a placeholder naming its Screen
  and Style_Direction.
- Each created image has one verdict radio group (keep, reject, mix) and a note textarea.
  Choosing a verdict writes immediately. Editing a note writes when the field loses focus,
  once a verdict is chosen. There is no debounce, so writes start inside the 1 second budget.
- A note over 500 characters shows the 500-character error and never calls `persistSelection`.
  The textarea has no `maxLength`, so the user can actually enter the oversized text and see the error.

## Types

`types.ts` re-declares the manifest and selection types from `src/design/refs/`. The HUD
tsconfig only includes `src`, so it cannot import across packages. Keep them in sync.

## Tests

`vitest.config.ts` at the repo root includes `friday-hud/src/design-review/**/*.test.{ts,tsx}`:

```
pnpm vitest run friday-hud/src/design-review
```

The tests run in the Node environment (the repo has no DOM test library). The write and
validation logic lives in `selection-writer.ts` and is tested directly. The component is
tested through `react-dom/server` markup, so click and blur wiring is not covered by a DOM test.
