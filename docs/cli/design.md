---
summary: "The design workflow: reference images, DESIGN.md, tokens, lint and visual regression"
read_when:
  - You want to change the HUD or other UI
  - You need to generate or update the design spec and tokens
---
# `friday design`

UI work follows one design spec. All commands run from the repository root and use the `design/` directory unless you pass `--dir <path>`.

## Workflow

1. **References.** Generate reference images.

   ```bash
   friday design refs
   ```

   This creates 2 images per style direction per screen, 18 in total. Running it again skips images that were already created and generates only the missing or failed ones. Add `--regenerate` to redo all of them.

2. **Review.** Open the images in the design review gallery and mark each one keep, reject or mix, with an optional note of up to 500 characters. Verdicts are saved to `selection.json`. A malformed file is reported and left unchanged.

3. **Spec.** Generate `DESIGN.md` from the keep and mix verdicts.

   ```bash
   friday design spec
   ```

4. **Tokens.** Validate `tokens.json` and generate `tokens.css` and `tailwind.tokens.js`.

   ```bash
   friday design tokens build
   ```

   If `tokens.json` is invalid, the command exits non-zero, lists each invalid token path, and writes nothing.

5. **Lint.** Check that UI code uses only token values for colour, spacing, type, radius and shadow.

   ```bash
   pnpm design:lint
   ```

6. **Visual regression.** Capture each screen at each window size and compare it with its baseline screenshot.

   ```bash
   node --import tsx src/design/visual-regression/cli.ts
   ```

   Any difference beyond the anti-aliasing tolerance marks that screen and size as failed, writes a diff image and exits non-zero. Add `--update` to replace the baselines after an intended change, and `--screen <name>` to check one screen.

## UI work needs a spec

If `design/DESIGN.md` is missing, UI changes do not start. Run `friday design refs` first, then the steps above.

## Platform support

The design tooling is tested on Linux. Windows support is an open question and is not decided.

Related: [Job engine](/concepts/job-engine), [`friday jobs`](/cli/jobs)
