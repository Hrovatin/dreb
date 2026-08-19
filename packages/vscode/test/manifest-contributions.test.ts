/**
 * Declarative validation of the VSCode `contributes` manifest wiring for the
 * editor right-click integration (issue 62). package.json menus are not covered
 * by the extension host unit tests, so a broken command id, an unreferenced
 * submenu, or a dropped `when` clause would ship silently. These tests assert
 * the manifest is internally consistent — every menu entry resolves to a
 * declared command or submenu — and that the Copilot-style "dreb" submenu
 * exposes the two selection actions with the correct visibility guard.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
	contributes: {
		commands: Array<{ command: string; title: string; category?: string }>;
		submenus?: Array<{ id: string; label: string }>;
		menus: Record<string, Array<{ command?: string; submenu?: string; when?: string; group?: string }>>;
	};
};

const { commands, submenus = [], menus } = manifest.contributes;
const commandIds = new Set(commands.map((c) => c.command));
const submenuIds = new Set(submenus.map((s) => s.id));

describe("contributes manifest wiring", () => {
	it("every menu command entry references a declared command", () => {
		for (const [menuId, entries] of Object.entries(menus)) {
			for (const entry of entries) {
				if (entry.command !== undefined) {
					expect(commandIds, `${menuId} references unknown command ${entry.command}`).toContain(entry.command);
				}
			}
		}
	});

	it("every menu submenu entry references a declared submenu", () => {
		for (const [menuId, entries] of Object.entries(menus)) {
			for (const entry of entries) {
				if (entry.submenu !== undefined) {
					expect(submenuIds, `${menuId} references unknown submenu ${entry.submenu}`).toContain(entry.submenu);
				}
			}
		}
	});

	it("every declared submenu is referenced by at least one menu and has its own menu contribution", () => {
		const referenced = new Set(
			Object.values(menus)
				.flat()
				.map((e) => e.submenu)
				.filter((s): s is string => s !== undefined),
		);
		for (const submenu of submenuIds) {
			expect(referenced, `submenu ${submenu} is declared but never referenced`).toContain(submenu);
			expect(menus, `submenu ${submenu} has no menu contribution`).toHaveProperty(submenu);
		}
	});
});

describe('editor right-click "dreb" submenu', () => {
	it("declares the dreb submenu with a dreb label", () => {
		expect(submenus).toContainEqual({ id: "dreb.editorContext", label: "dreb" });
	});

	it("nests dreb actions under the submenu instead of a bare top-level command", () => {
		const editorContext = menus["editor/context"] ?? [];
		expect(editorContext).toContainEqual(expect.objectContaining({ submenu: "dreb.editorContext" }));
		// The selection commands must live in the submenu, not directly in editor/context.
		for (const entry of editorContext) {
			expect(entry.command).not.toBe("dreb.tagSelectionToChat");
			expect(entry.command).not.toBe("dreb.tagSelectionToNewChat");
		}
	});

	it("exposes both selection actions, guarded by an active selection", () => {
		const submenu = menus["dreb.editorContext"] ?? [];
		for (const command of ["dreb.tagSelectionToChat", "dreb.tagSelectionToNewChat"]) {
			const entry = submenu.find((e) => e.command === command);
			expect(entry, `${command} missing from dreb submenu`).toBeDefined();
			expect(entry?.when).toBe("editorHasSelection");
		}
	});

	it("contains only the two selection actions (no other commands leak into the submenu)", () => {
		const submenu = menus["dreb.editorContext"] ?? [];
		const submenuCommands = submenu.map((e) => e.command).sort();
		expect(submenuCommands).toEqual(["dreb.tagSelectionToChat", "dreb.tagSelectionToNewChat"]);
	});

	it("keeps the reject-hunk review action out of every menu (command-palette only)", () => {
		const inAnyMenu = Object.values(menus)
			.flat()
			.some((e) => e.command === "dreb.review.rejectHunkAtCursor");
		expect(inAnyMenu, "dreb.review.rejectHunkAtCursor must not appear in any menu").toBe(false);
		// It must still be a declared command so the Command Palette can run it.
		expect(commandIds).toContain("dreb.review.rejectHunkAtCursor");
	});

	it("declares both selection commands with distinct titles under the dreb category", () => {
		for (const command of ["dreb.tagSelectionToChat", "dreb.tagSelectionToNewChat"]) {
			const declared = commands.find((c) => c.command === command);
			expect(declared, `${command} not declared in contributes.commands`).toBeDefined();
			expect(declared?.category).toBe("dreb");
		}
		const chat = commands.find((c) => c.command === "dreb.tagSelectionToChat");
		const newChat = commands.find((c) => c.command === "dreb.tagSelectionToNewChat");
		expect(chat?.title).not.toBe(newChat?.title);
	});
});
