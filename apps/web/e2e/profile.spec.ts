import { test, expect } from '@playwright/test';
import {
  gotoAsAuthenticated,
  assertNoHorizontalOverflow,
  assertNoConsoleErrors,
  assertNoFailedRequests,
  assertBoundingBoxInViewport,
} from './fixtures';

/**
 * E2E tests for /onboarding/profile.
 *
 * Focus: the ARIA editable combobox (`TimezoneSelect`) — keyboard navigation,
 * `aria-activedescendant` correctness, free-text validation, and the standard
 * layout invariants (no overflow, no console errors, no failed requests).
 *
 * Every test re-establishes its own interception + collector state so the suite
 * is fully parallel-safe and individually repeatable.
 */

test.describe('Onboarding / Profile', () => {
  test.beforeEach(async ({ page }) => {
    await gotoAsAuthenticated(page, '/onboarding/profile', { heading: /trader profile/i });
  });

  // ── Page-load invariants ──────────────────────────────────────────────────

  test('page loads with authenticated state', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1, name: /trader profile/i })).toBeVisible();
    // The "Save profile & continue" button only renders when authenticated.
    await expect(page.getByRole('button', { name: /save profile & continue/i })).toBeVisible();
  });

  test('no horizontal overflow at every project viewport', async ({ page }) => {
    await assertNoHorizontalOverflow(page);
  });

  test('no console errors', async ({ page }) => {
    // Give any pending effects (profile fetch) a chance to settle.
    await expect(page.locator('.timezone-select__selected-display')).toBeVisible();
    assertNoConsoleErrors(page);
  });

  test('no failed network requests', async ({ page }) => {
    await expect(page.locator('.timezone-select__selected-display')).toBeVisible();
    assertNoFailedRequests(page);
  });

  // ── Timezone combobox ARIA attributes ─────────────────────────────────────

  test('timezone combobox has role="combobox"', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await expect(combobox).toBeVisible();
    await expect(combobox).toHaveAttribute('role', 'combobox');
  });

  test('combobox has aria-expanded reflecting open state', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    // Closed initially.
    await expect(combobox).toHaveAttribute('aria-expanded', 'false');
    // Open via click.
    await combobox.click();
    await expect(combobox).toHaveAttribute('aria-expanded', 'true');
  });

  test('combobox has aria-controls pointing at the listbox when open', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    // Wait for React to re-render with open=true (listbox appears).
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    // Now aria-controls is populated.
    await expect(combobox).toHaveAttribute('aria-controls', /.+/);
    const listboxId = await combobox.getAttribute('aria-controls');
    expect(listboxId, 'aria-controls must be set when open').toBeTruthy();
    const listboxById = page.locator(`[id="${listboxId}"]`)
    await expect(listboxById).toBeVisible();
    await expect(listboxById).toHaveAttribute('role', 'listbox');
  });

  test('combobox has aria-autocomplete="list"', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await expect(combobox).toHaveAttribute('aria-autocomplete', 'list');
  });

  test('aria-activedescendant is absent when closed', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    // Ensure closed.
    await expect(combobox).toHaveAttribute('aria-expanded', 'false');
    const ad = await combobox.getAttribute('aria-activedescendant');
    expect(ad).toBeNull();
  });

  test('aria-activedescendant references a rendered option when open', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    // Wait for React to set activeIndex (happens in a useEffect after render)
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    const activeId = await combobox.getAttribute('aria-activedescendant');
    expect(activeId, 'aria-activedescendant must be set when open').toBeTruthy();
    const activeOption = page.locator(`[id="${activeId}"]`)
    await expect(activeOption).toBeVisible();
    await expect(activeOption).toHaveAttribute('role', 'option');
  });

  // ── Opening & listbox rendering ───────────────────────────────────────────

  test('opening combobox shows listbox with options', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    const options = listbox.getByRole('option');
    // The curated fallback list has ~50 entries; Intl.supportedValuesOf may
    // return more. Either way, there must be many options.
    const count = await options.count();
    expect(count, 'Expected multiple timezone options').toBeGreaterThan(10);
  });

  // ── Keyboard navigation ────────────────────────────────────────────────────

  test('ArrowDown moves active option forward', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    const firstActiveId = await combobox.getAttribute('aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    await expect(combobox).not.toHaveAttribute('aria-activedescendant', firstActiveId ?? '', { timeout: 5000 });
    const nextActiveId = await combobox.getAttribute('aria-activedescendant');
    expect(nextActiveId, 'active id must still be set').toBeTruthy();
    expect(nextActiveId, 'active id must change after ArrowDown').not.toBe(firstActiveId);
    await expect(page.locator(`[id="${nextActiveId}"]`)).toHaveAttribute('role', 'option');
  });

  test('ArrowUp moves active option backward', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    const initialId = await combobox.getAttribute('aria-activedescendant');
    // Move forward twice.
    await page.keyboard.press('ArrowDown');
    await expect(combobox).not.toHaveAttribute('aria-activedescendant', initialId ?? '', { timeout: 5000 });
    const secondId = await combobox.getAttribute('aria-activedescendant');
    await page.keyboard.press('ArrowDown');
    await expect(combobox).not.toHaveAttribute('aria-activedescendant', secondId ?? '', { timeout: 5000 });
    const midActiveId = await combobox.getAttribute('aria-activedescendant');
    // Back once.
    await page.keyboard.press('ArrowUp');
    await expect(combobox).not.toHaveAttribute('aria-activedescendant', midActiveId ?? '', { timeout: 5000 });
    const backActiveId = await combobox.getAttribute('aria-activedescendant');
    expect(backActiveId).not.toBe(midActiveId);
    await expect(page.locator(`[id="${backActiveId}"]`)).toHaveAttribute('role', 'option');
  });

  test('Home moves active option to the first', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    // Move away from the first option.
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    // Home → first option.
    await page.keyboard.press('Home');
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    const activeId = await combobox.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    const firstOption = listbox.getByRole('option').first();
    await expect(firstOption).toHaveId(activeId as string);
  });

  test('End moves active option to the last', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    const initialId = await combobox.getAttribute('aria-activedescendant');
    await page.keyboard.press('End');
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    const endActiveId = await combobox.getAttribute('aria-activedescendant');
    expect(endActiveId, 'active id must be set after End').toBeTruthy();
    expect(endActiveId, 'End must move to a different option').not.toBe(initialId);
    await expect(page.locator(`[id="${endActiveId}"]`)).toHaveAttribute('role', 'option');
  });

  test('Enter selects the active option and closes the combobox', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    const firstOption = listbox.getByRole('option').first();
    const ianaText = (await firstOption.locator('.timezone-select__option-iana').textContent()) ?? '';

    await page.keyboard.press('Enter');
    // Listbox unmounts.
    await expect(listbox).toHaveCount(0);
    await expect(combobox).toHaveAttribute('aria-expanded', 'false');
    // Selected display now shows the chosen IANA.
    await expect(page.locator('.timezone-select__selected-display')).toContainText(ianaText);
  });

  test('Escape closes the combobox and keeps focus on the input', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(listbox).toHaveCount(0);
    await expect(combobox).toHaveAttribute('aria-expanded', 'false');
    // Escape should not move focus away from the combobox.
    await expect(combobox).toBeFocused();
  });

  test('Tab closes the combobox without trapping focus', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(listbox).toHaveCount(0);
    await expect(combobox).toHaveAttribute('aria-expanded', 'false');
    // Focus must have moved on — not trapped inside the combobox.
    await expect(combobox).not.toBeFocused();
  });

  // ── Selection state ───────────────────────────────────────────────────────

  test('selecting a timezone updates the visible display', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    const displayLocator = page.locator('.timezone-select__selected-display');
    await expect(displayLocator).toBeVisible();
    const displayBefore = (await displayLocator.textContent()) ?? '';

    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    const firstActiveId = await combobox.getAttribute('aria-activedescendant');

    // Move to a timezone that is DIFFERENT from the currently-selected one.
    // The list is sorted by city; the selected "Africa/Accra" sits at index 1,
    // so a single ArrowDown from index 0 (Abidjan) lands on the already-selected
    // value and would not change the display. Press ArrowDown until the active
    // option's IANA differs from the selected value.
    let activeId = firstActiveId;
    let ianaText = '';
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press('ArrowDown');
      // Wait until the active id actually CHANGES (not just non-empty) so we
      // read the new option rather than a stale pre-render value.
      await expect(combobox).not.toHaveAttribute('aria-activedescendant', activeId ?? '', { timeout: 5000 });
      activeId = await combobox.getAttribute('aria-activedescendant');
      expect(activeId, 'active id must be set after ArrowDown').toBeTruthy();
      const activeOptionEl = page.locator(`[id="${activeId}"]`);
      ianaText = (await activeOptionEl.locator('.timezone-select__option-iana').textContent()) ?? '';
      if (ianaText && !displayBefore.includes(ianaText)) break;
    }
    expect(activeId, 'active id must have moved from the first option').not.toBe(firstActiveId);
    expect(ianaText, 'must have navigated to a timezone').toBeTruthy();
    expect(displayBefore, 'must have navigated to a DIFFERENT timezone than selected').not.toContain(ianaText);

    await page.keyboard.press('Enter');
    // Listbox closes.
    await expect(listbox).toHaveCount(0);
    // Selected display updates.
    await expect(displayLocator).toContainText(ianaText);
    const displayAfter = (await displayLocator.textContent()) ?? '';
    expect(displayAfter).not.toBe(displayBefore);
  });

  test('reopening after selection shows correct aria-selected on the chosen option', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });

    // Select the first option.
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    const firstActiveId = await combobox.getAttribute('aria-activedescendant');
    expect(firstActiveId).toBeTruthy();
    await page.keyboard.press('Enter');
    await expect(listbox).toHaveCount(0);

    // Reopen.
    await combobox.click();
    await expect(listbox).toBeVisible();

    // The previously-selected option should now have aria-selected="true".
    const selectedOption = page.locator(`[id="${firstActiveId}"]`)
    await expect(selectedOption).toHaveAttribute('aria-selected', 'true');
  });

  test('invalid free text cannot be saved (no commit for unrecognized timezone)', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });

    // Capture the current display (the mock profile sets Africa/Accra).
    await expect(page.locator('.timezone-select__selected-display')).toContainText('Africa/Accra');
    const displayBefore = (await page.locator('.timezone-select__selected-display').textContent()) ?? '';

    // Open and type an invalid timezone.
    await combobox.click();
    await combobox.fill('ZZZZ-Not-A-Real-Timezone');
    // Enter with no matching options → no commit.
    await page.keyboard.press('Enter');
    // Escape to close.
    await page.keyboard.press('Escape');

    // Display should be unchanged — invalid text was not committed.
    const displayAfter = (await page.locator('.timezone-select__selected-display').textContent()) ?? '';
    expect(displayAfter).toBe(displayBefore);
    expect(displayAfter).toContain('Africa/Accra');
    expect(displayAfter).not.toContain('ZZZZ-Not-A-Real-Timezone');
  });

  // ── Form & button presence ────────────────────────────────────────────────

  test('Save button exists and is visible', async ({ page }) => {
    const saveButton = page.getByRole('button', { name: /save profile & continue/i });
    await expect(saveButton).toBeVisible();
    await expect(saveButton).toBeEnabled();
  });

  test('all form labels are visible (not placeholder-only)', async ({ page }) => {
    // Every form field must have a visible <label> (or labeled control), not
    // rely on placeholder text alone.
    const expectedLabels = [
      'First name',
      'Last name',
      'Country code (2 letters)',
      'Timezone',
      'Preferred currency (3 letters)',
    ];
    for (const labelText of expectedLabels) {
      await expect(
        page.locator('.input-label', { hasText: labelText }).first(),
        `Expected visible label "${labelText}"`,
      ).toBeVisible();
    }
  });

  // ── Focus indicators ──────────────────────────────────────────────────────

  test('focus indicators are visible (focus-visible styles exist and apply)', async ({ page }) => {
    // (1) Static check: the stylesheet defines :focus-visible rules.
    const hasFocusVisibleCSS = await page.evaluate(() => {
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const rules = sheet.cssRules;
          for (let i = 0; i < rules.length; i++) {
            const text = (rules[i] as CSSRule).cssText ?? '';
            if (text.includes(':focus-visible')) return true;
          }
        } catch {
          // cross-origin stylesheet — skip
        }
      }
      return false;
    });
    expect(hasFocusVisibleCSS, 'Stylesheet must define :focus-visible rules').toBe(true);

    // (2) Runtime check: Tab to an element and verify it gets a visible
    // focus indicator (non-default box-shadow or outline).
    await page.keyboard.press('Tab');
    const focusedInfo = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el) return null;
      const cs = window.getComputedStyle(el);
      return {
        tag: el.tagName,
        boxShadow: cs.boxShadow,
        outline: cs.outline,
        outlineColor: cs.outlineColor,
      };
    });
    expect(focusedInfo, 'An element must be focused after Tab').not.toBeNull();
    const hasIndicator =
      !!focusedInfo &&
      ((focusedInfo.boxShadow && focusedInfo.boxShadow !== 'none') ||
        (focusedInfo.outline && focusedInfo.outline !== 'none' && !focusedInfo.outline.startsWith('none')));
    expect(
      hasIndicator,
      `Focused element must show a visible focus indicator. Got: ${JSON.stringify(focusedInfo)}`,
    ).toBe(true);
  });

  // ── Layout ────────────────────────────────────────────────────────────────

  test('open listbox bounding box stays within viewport', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    // The dropdown container is the absolutely-positioned panel. Its bounding
    // box (including the bottom edge) must stay fully within the viewport —
    // no relaxation for "slightly below the viewport". The component caps the
    // list max-height and flips the dropdown above the trigger when needed.
    const dropdown = page.locator('.timezone-select__dropdown');
    await expect(dropdown).toBeVisible();
    await assertBoundingBoxInViewport(dropdown);
  });

  // ── Short-screen listbox regression ───────────────────────────────────────
  // Regression for the defect where the timezone listbox extended below the
  // viewport on shorter screens (the combobox is low in the page and the
  // default 280px list overflowed the bottom edge). Covers every project's
  // viewport: the listbox must stay within the viewport, the active option
  // (reached via End) must be scrolled into view and remain visible, keyboard
  // navigation must keep working, and there must be no horizontal overflow.
  test('short-screen: End selects last option, active option visible, listbox in viewport', async ({ page }) => {
    const combobox = page.getByRole('combobox', { name: /timezone/i });
    await combobox.click();
    const listbox = page.getByRole('listbox', { name: /timezone/i });
    await expect(listbox).toBeVisible();
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    const initialId = await combobox.getAttribute('aria-activedescendant');

    // End → last option.
    await page.keyboard.press('End');
    await expect(combobox).not.toHaveAttribute('aria-activedescendant', initialId ?? '', { timeout: 5000 });
    await expect(combobox).toHaveAttribute('aria-activedescendant', /.+/, { timeout: 5000 });
    const endActiveId = await combobox.getAttribute('aria-activedescendant');
    expect(endActiveId, 'active id must be set after End').toBeTruthy();
    expect(endActiveId, 'End must move to a different option').not.toBe(initialId);

    // The active (last) option must be scrolled into view within the list.
    const activeOption = page.locator(`[id="${endActiveId}"]`);
    await expect(activeOption).toBeVisible();
    await expect(activeOption).toHaveAttribute('role', 'option');

    // The dropdown panel must remain fully within the viewport (bottom edge
    // included) — this is the core of the short-screen regression.
    const dropdown = page.locator('.timezone-select__dropdown');
    await assertBoundingBoxInViewport(dropdown);

    // No horizontal overflow introduced by the open listbox.
    await assertNoHorizontalOverflow(page);

    // Keyboard navigation still works: ArrowUp from the last option moves back.
    await page.keyboard.press('ArrowUp');
    await expect(combobox).not.toHaveAttribute('aria-activedescendant', endActiveId ?? '', { timeout: 5000 });
    const upActiveId = await combobox.getAttribute('aria-activedescendant');
    expect(upActiveId).not.toBe(endActiveId);
    await expect(page.locator(`[id="${upActiveId}"]`)).toHaveAttribute('role', 'option');
    // Still within viewport after navigation.
    await assertBoundingBoxInViewport(dropdown);
  });
});
