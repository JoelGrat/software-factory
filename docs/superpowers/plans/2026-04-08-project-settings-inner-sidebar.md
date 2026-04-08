# Project Settings Inner Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tab-style inner sidebar to the project settings page so users can navigate between sections without scrolling.

**Architecture:** All changes are confined to one file (`project-settings-view.tsx`). Add `activeSection` state, an inner `<nav>` sidebar listing 11 sections, and conditional rendering so only the active section's content is shown. The System Behavior Summary banner becomes persistent above the switching content.

**Tech Stack:** Next.js 14 App Router, React, Tailwind CSS. No new dependencies.

---

## Files

- Modify: `app/projects/[id]/settings/project-settings-view.tsx`

---

### Task 1: Add `SectionId` type, `SECTIONS` constant, and `activeSection` state

**Files:**
- Modify: `app/projects/[id]/settings/project-settings-view.tsx`

- [ ] **Step 1: Add `SectionId` type and `SECTIONS` constant after the existing type declarations (after line 37, before `const DEFAULTS`)**

```tsx
type SectionId =
  | 'general' | 'repository' | 'execution' | 'risk-policy'
  | 'scan-model' | 'test-strategy' | 'exec-environment'
  | 'notifications' | 'automation' | 'model-health' | 'danger-zone'

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'general',          label: 'General' },
  { id: 'repository',       label: 'Repository' },
  { id: 'execution',        label: 'Execution' },
  { id: 'risk-policy',      label: 'Risk Policy' },
  { id: 'scan-model',       label: 'Scan & Model' },
  { id: 'test-strategy',    label: 'Test Strategy' },
  { id: 'exec-environment', label: 'Exec Environment' },
  { id: 'notifications',    label: 'Notifications' },
  { id: 'automation',       label: 'Automation' },
  { id: 'model-health',     label: 'Model Health' },
  { id: 'danger-zone',      label: 'Danger Zone' },
]
```

- [ ] **Step 2: Add `activeSection` state inside `ProjectSettingsView`, after the existing `useState` calls**

```tsx
const [activeSection, setActiveSection] = useState<SectionId>('general')
```

- [ ] **Step 3: Verify the file compiles with no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: no errors

---

### Task 2: Add inner sidebar to layout

**Files:**
- Modify: `app/projects/[id]/settings/project-settings-view.tsx`

- [ ] **Step 1: Change the `<main>` element's className**

Find (around line 236):
```tsx
<main className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
```

Replace with:
```tsx
<main className="flex flex-1 overflow-hidden">
```

- [ ] **Step 2: Add the inner sidebar `<nav>` as the first child of `<main>`, before the content div**

```tsx
<nav className="w-44 flex-shrink-0 bg-[#131b2e] border-r border-white/5 overflow-y-auto py-6 px-3 space-y-0.5">
  {SECTIONS.map(({ id, label }) => (
    <button
      key={id}
      type="button"
      onClick={() => setActiveSection(id)}
      className={`w-full text-left px-3 py-2 rounded-l-lg text-xs font-semibold font-headline tracking-wide transition-all ${
        activeSection === id
          ? 'bg-indigo-500/10 text-indigo-400 border-r-4 border-indigo-500'
          : 'text-slate-400 hover:text-slate-200 hover:bg-[#171f33] border-r-4 border-transparent'
      }`}
    >
      {label}
    </button>
  ))}
</nav>
```

- [ ] **Step 3: Wrap the existing content (the `<div className="max-w-2xl mx-auto space-y-8">` and everything inside it) in a new scrollable content panel div**

The existing `<div className="max-w-2xl mx-auto space-y-8">` becomes a child of:
```tsx
<div className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
  {/* content here */}
</div>
```

So the full `<main>` structure is now:
```tsx
<main className="flex flex-1 overflow-hidden">
  <nav className="w-44 flex-shrink-0 bg-[#131b2e] border-r border-white/5 overflow-y-auto py-6 px-3 space-y-0.5">
    {/* sidebar buttons */}
  </nav>
  <div className="flex-1 overflow-y-auto bg-[#0b1326] p-10">
    <div className="max-w-2xl mx-auto space-y-8">
      {/* all existing content unchanged for now */}
    </div>
  </div>
</main>
```

- [ ] **Step 4: Check the page renders correctly in the browser — sidebar appears on left, existing content on right**

Navigate to any project's settings page. You should see:
- The inner sidebar on the left with 11 items (all visible, no active highlight yet)
- All existing settings content on the right
- No layout breakage

---

### Task 3: Move System Behavior banner to persistent position

**Files:**
- Modify: `app/projects/[id]/settings/project-settings-view.tsx`

- [ ] **Step 1: Move the title block and System Behavior Summary card outside and above the `<form>`, keeping them inside `<div className="max-w-2xl mx-auto space-y-8">`**

The current order inside `max-w-2xl` is:
1. Title div
2. System Behavior Summary div
3. `<form>` containing sections + save
4. Danger Zone `<section>`

This order stays the same — the title and banner are already above the form. No move needed. The next task (conditional rendering) will naturally keep them persistent since only the sections inside the form get wrapped in conditionals.

- [ ] **Step 2: Verify System Behavior Summary is outside the `<form>` tag**

Confirm the `<div className="rounded-xl bg-indigo-500/5 ...">` containing the behavior summary comes **before** the `<form onSubmit={handleSave}>` opening tag. If it is already (it is in the original), no change is needed.

---

### Task 4: Make sections conditional on `activeSection`

**Files:**
- Modify: `app/projects/[id]/settings/project-settings-view.tsx`

This task wraps each section inside the `<form>` with `{activeSection === 'id' && (...)}`. It also adds a per-section save bar and removes the single shared save bar at the bottom of the form. The Danger Zone section (outside the form) and Model Health section are also made conditional.

- [ ] **Step 1: Define the save bar JSX as a const inside the component, after the existing state declarations**

```tsx
const saveBar = (
  <div className="flex items-center gap-3 pt-2">
    <button
      type="submit"
      disabled={saving}
      className="px-5 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {saving ? 'Saving…' : 'Save changes'}
    </button>
    {saveSuccess && <span className="text-xs text-emerald-400 font-medium">Saved</span>}
    {saveError && <span className="text-xs text-red-400">{saveError}</span>}
  </div>
)
```

- [ ] **Step 2: Remove the existing save bar from the bottom of the `<form>`**

Find and delete this block (near the end of the form, before `</form>`):
```tsx
{/* Save */}
<div className="flex items-center gap-3">
  <button type="submit" disabled={saving}
    className="px-5 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed">
    {saving ? 'Saving…' : 'Save changes'}
  </button>
  {saveSuccess && <span className="text-xs text-emerald-400 font-medium">Saved</span>}
  {saveError && <span className="text-xs text-red-400">{saveError}</span>}
</div>
```

- [ ] **Step 3: Wrap the Execution Behavior section and add saveBar**

Find the Execution Behavior section (the `<div className={sectionClass}>` that starts with `<SectionTitle>Execution Behavior</SectionTitle>`). Wrap it:

```tsx
{activeSection === 'execution' && (
  <>
    <div className={sectionClass}>
      {/* ... existing Execution Behavior content unchanged ... */}
    </div>
    {saveBar}
  </>
)}
```

- [ ] **Step 4: Wrap the Risk Policy section and add saveBar**

```tsx
{activeSection === 'risk-policy' && (
  <>
    <div className={sectionClass}>
      {/* ... existing Risk Policy content unchanged ... */}
    </div>
    {saveBar}
  </>
)}
```

- [ ] **Step 5: Wrap the Scan & Model section and add saveBar**

```tsx
{activeSection === 'scan-model' && (
  <>
    <div className={sectionClass}>
      {/* ... existing Scan & Model content unchanged ... */}
    </div>
    {saveBar}
  </>
)}
```

- [ ] **Step 6: Wrap the Test Strategy section and add saveBar**

```tsx
{activeSection === 'test-strategy' && (
  <>
    <div className={sectionClass}>
      {/* ... existing Test Strategy content unchanged ... */}
    </div>
    {saveBar}
  </>
)}
```

- [ ] **Step 7: Wrap the Execution Environment section and add saveBar**

```tsx
{activeSection === 'exec-environment' && (
  <>
    <div className={sectionClass}>
      {/* ... existing Execution Environment content unchanged ... */}
    </div>
    {saveBar}
  </>
)}
```

- [ ] **Step 8: Wrap the Notifications section and add saveBar**

```tsx
{activeSection === 'notifications' && (
  <>
    <div className={sectionClass}>
      {/* ... existing Notifications content unchanged ... */}
    </div>
    {saveBar}
  </>
)}
```

- [ ] **Step 9: Wrap the Automation section and add saveBar**

```tsx
{activeSection === 'automation' && (
  <>
    <div className={sectionClass}>
      {/* ... existing Automation content unchanged ... */}
    </div>
    {saveBar}
  </>
)}
```

- [ ] **Step 10: Wrap the Model Health section (no saveBar — read-only)**

```tsx
{activeSection === 'model-health' && modelHealth.componentCount > 0 && (
  <div className={sectionClass}>
    {/* ... existing Model Health content unchanged ... */}
  </div>
)}
```

Note: The `modelHealth.componentCount > 0` guard from the original is preserved.

- [ ] **Step 11: Wrap the General section and add saveBar**

```tsx
{activeSection === 'general' && (
  <>
    <div className={sectionClass}>
      {/* ... existing General content unchanged ... */}
    </div>
    {saveBar}
  </>
)}
```

- [ ] **Step 12: Wrap the Repository section and add saveBar**

```tsx
{activeSection === 'repository' && (
  <>
    <div className={sectionClass}>
      {/* ... existing Repository content unchanged ... */}
    </div>
    {saveBar}
  </>
)}
```

- [ ] **Step 13: Wrap the Danger Zone section (outside the form, no saveBar)**

The `<section className="rounded-xl border border-red-500/20 ...">` lives outside the `<form>`. Wrap it:

```tsx
{activeSection === 'danger-zone' && (
  <section className="rounded-xl border border-red-500/20 p-6 space-y-4">
    {/* ... existing Danger Zone content unchanged ... */}
  </section>
)}
```

- [ ] **Step 14: Verify no TypeScript errors**

Run: `npx tsc --noEmit`
Expected: no errors

---

### Task 5: Visual test and final commit

**Files:**
- Modify: `app/projects/[id]/settings/project-settings-view.tsx`

- [ ] **Step 1: Start dev server**

Run: `npm run dev`

- [ ] **Step 2: Navigate to a project's settings page and verify the following**

- Inner sidebar shows 11 items, default active is "General" (indigo highlight + right border)
- "General" section content (project name, created date) is visible
- System Behavior Summary banner is visible above the section content
- Clicking "Repository" in the sidebar → shows repository form, General form hidden
- Clicking "Execution" → shows Execution Behavior form
- Each editable section has a "Save changes" button at the bottom
- Clicking save on any section saves all settings (it's one global save)
- "Model Health" shows the stats grid (if project has components)
- "Danger Zone" shows the delete confirmation form
- No sections are visible simultaneously
- Layout: LeftNav (w-64) → inner sidebar (w-44) → content panel (flex-1)

- [ ] **Step 3: Commit**

```bash
git add app/projects/[id]/settings/project-settings-view.tsx
git commit -m "feat: add inner sidebar to project settings with tab-style section switching"
```
