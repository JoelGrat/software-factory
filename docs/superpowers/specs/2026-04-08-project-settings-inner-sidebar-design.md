# Project Settings — Inner Sidebar Design

**Date:** 2026-04-08  
**Status:** Approved  

## Problem

The project settings page (`app/projects/[id]/settings/project-settings-view.tsx`) is a single long scrollable form with 11 sections. There is no navigation aid, so users must scroll through everything to reach a specific section.

## Solution

Add a small inner sidebar (tab-style) inside the settings view. Clicking a sidebar item shows only that section's content. The main `LeftNav` is unchanged.

## Layout

```
<header />                              ← existing h-16 topbar (unchanged)
<div class="flex flex-1 overflow-hidden">
  <LeftNav />                           ← unchanged
  <main class="flex flex-1 overflow-hidden">
    <nav class="w-44 ...">             ← inner sidebar
    <div class="flex-1 overflow-y-auto p-10">
      <SystemBehaviorBanner />          ← persistent, always visible
      <ActiveSectionContent />          ← switches on sidebar click
    </div>
  </main>
</div>
```

`main` changes from `flex-1 overflow-y-auto` to `flex flex-1 overflow-hidden flex-row`.

## Inner Sidebar

- Width: `w-44`, `flex-shrink-0`
- Background: `bg-[#131b2e]`, `border-r border-white/5`
- Padding: `py-6 px-3`, `overflow-y-auto`
- Each item: `<button>` with full width, `text-xs font-semibold font-headline tracking-wide`
- **Active state:** `bg-indigo-500/10 text-indigo-400 border-r-4 border-indigo-500 rounded-l-lg`
- **Hover state:** `hover:bg-[#171f33] text-slate-300`
- **Default active section:** `general`

## Sections (11 items)

| ID | Label |
|----|-------|
| `general` | General |
| `repository` | Repository |
| `execution` | Execution |
| `risk-policy` | Risk Policy |
| `scan-model` | Scan & Model |
| `test-strategy` | Test Strategy |
| `exec-environment` | Exec Environment |
| `notifications` | Notifications |
| `automation` | Automation |
| `model-health` | Model Health |
| `danger-zone` | Danger Zone |

## System Behavior Banner

The existing "System Behavior" summary card (`rounded-xl bg-indigo-500/5 border border-indigo-500/20`) moves to a persistent position at the top of the content panel, above the active section content. It is always visible regardless of which section is active.

## State & Form

- Add `activeSection` state (type: union of 11 section ID strings), default `'general'`
- The existing `<form onSubmit={handleSave}>` wraps the entire content panel — React preserves all form state when switching sections since non-active sections are not unmounted but conditionally rendered via `activeSection === id`
- The **Save button** appears at the bottom of each editable section (all except `model-health` and `danger-zone`)
- `model-health` is read-only — no save button
- `danger-zone` has its own delete action — no save button

## Components Affected

- `app/projects/[id]/settings/project-settings-view.tsx` — all changes are in this single file. No new files needed.
