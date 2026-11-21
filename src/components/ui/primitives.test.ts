// @vitest-environment happy-dom
import { act, createElement, createRef, Fragment, useState, type FormEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Badge } from "./badge";
import { Button, buttonVariants } from "./button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";
import { Field, Input, SearchInput } from "./field";

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const render = (children: ReactNode) => act(() => root.render(children));
const click = (element: HTMLElement) => act(() => element.click());
const type = (input: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
});

describe("Button", () => {
  it("defaults to a secondary medium native button that does not submit its form", () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    const onKeyDown = vi.fn();
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    const buttonProps = {
      ref, id: "preview", name: "action", value: "preview", title: "Preview changes", tabIndex: 2,
      "aria-label": "Preview", "aria-describedby": "preview-help", "data-action": "preview",
      className: "fixture-button px-8", onClick, onKeyDown,
    };
    render(createElement("form", { id: "actions", onSubmit }, createElement(Button, buttonProps, "Preview")));

    const button = host.querySelector("button")!;
    expect(ref.current).toBe(button);
    expect(button.type).toBe("button");
    expect(button.form?.id).toBe("actions");
    expect(button.id).toBe("preview");
    expect(button.name).toBe("action");
    expect(button.value).toBe("preview");
    expect(button.title).toBe("Preview changes");
    expect(button.tabIndex).toBe(2);
    expect(button.getAttribute("aria-label")).toBe("Preview");
    expect(button.getAttribute("aria-describedby")).toBe("preview-help");
    expect(button.dataset.action).toBe("preview");
    expect(button.classList.contains("eac-button-secondary")).toBe(true);
    expect(button.classList.contains("h-8")).toBe(true);
    expect(button.classList.contains("fixture-button")).toBe(true);
    expect(button.classList.contains("px-8")).toBe(true);
    expect(button.classList.contains("px-3")).toBe(false);
    expect(buttonVariants()).toContain("eac-button-secondary");

    click(button);
    act(() => { button.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(onClick).toHaveBeenCalledOnce();
    expect(onKeyDown).toHaveBeenCalledOnce();
    expect(onKeyDown.mock.calls[0][0].key).toBe("ArrowRight");
    expect(onSubmit).not.toHaveBeenCalled();
    render(null);
    expect(ref.current).toBeNull();
  });

  it("preserves disabled native activation and explicit submit behavior", () => {
    const onClick = vi.fn();
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault());
    const form = (disabled: boolean) => createElement("form", { onSubmit },
      createElement(Button, { type: "submit", disabled, onClick }, "Save"));
    render(form(true));
    const button = host.querySelector("button")!;
    expect(button.disabled).toBe(true);
    expect(button.type).toBe("submit");
    click(button);
    expect(onClick).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();

    render(form(false));
    click(button);
    expect(onClick).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it("forwards React 19 callback refs and their cleanup", () => {
    const cleanup = vi.fn();
    const ref = vi.fn((_node: HTMLButtonElement | null) => cleanup);
    render(createElement(Button, { ref }, "Open"));
    expect(ref).toHaveBeenCalledExactlyOnceWith(host.querySelector("button"));
    render(null);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it.each(["primary", "secondary", "outline", "ghost", "danger", "warning"] as const)(
    "composes the %s variant without exposing styling props on the DOM", (variant) => {
      render(createElement(Button, { variant, size: "sm", className: "fixture-button" }, "Action"));
      const button = host.querySelector("button")!;
      expect(button.classList.contains("eac-button")).toBe(true);
      expect(button.classList.contains(`eac-button-${variant}`)).toBe(true);
      expect(button.classList.contains("fixture-button")).toBe(true);
      expect(button.hasAttribute("variant")).toBe(false);
      expect(button.hasAttribute("size")).toBe(false);
    },
  );

  it.each([["sm", "h-7"], ["md", "h-8"], ["lg", "h-10"], ["icon", "size-7"]] as const)(
    "retains the %s size contract", (size, sizeClass) => {
      render(createElement(Button, { size, "aria-label": "Open menu" }, "Menu"));
      const button = host.querySelector("button")!;
      expect(button.classList.contains(sizeClass)).toBe(true);
      expect(buttonVariants({ size })).toContain(sizeClass);
      expect(button.hasAttribute("size")).toBe(false);
    },
  );
});

describe.each([["Input", Input], ["SearchInput", SearchInput]] as const)("%s", (_name, Component) => {
  it("forwards native attributes and refs, exposes the supplied accessible name, and preserves an editable default value", () => {
    const ref = createRef<HTMLInputElement>();
    const onInput = vi.fn();
    const onFocus = vi.fn();
    const onKeyDown = vi.fn();
    render(createElement("form", { id: "profile" }, createElement(Component, {
      ref, type: "email", id: "email", name: "email", defaultValue: "ada@example.test",
      "aria-label": "Email address", "aria-describedby": "email-help", "aria-invalid": true,
      className: "fixture-input py-3", onInput, onFocus, onKeyDown,
    })));
    const input = host.querySelector("input")!;
    expect(ref.current).toBe(input);
    expect(input.type).toBe("email");
    expect(input.id).toBe("email");
    expect(input.name).toBe("email");
    expect(input.value).toBe("ada@example.test");
    expect(input.defaultValue).toBe("ada@example.test");
    expect(input.getAttribute("aria-label")).toBe("Email address");
    expect(input.getAttribute("aria-describedby")).toBe("email-help");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.classList.contains("eac-input")).toBe(true);
    expect(input.classList.contains("fixture-input")).toBe(true);
    expect(input.classList.contains("py-3")).toBe(true);
    expect(input.classList.contains("py-2")).toBe(false);
    expect(input.labels).toHaveLength(0);

    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    expect(onFocus).toHaveBeenCalledOnce();
    type(input, "grace@example.test");
    expect(input.value).toBe("grace@example.test");
    expect(onInput).toHaveBeenCalledOnce();
    act(() => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onKeyDown.mock.calls[0][0].key).toBe("Enter");
    expect(new FormData(host.querySelector("form")!).get("email")).toBe("grace@example.test");
    act(() => host.querySelector("form")!.reset());
    expect(input.value).toBe("ada@example.test");
    render(null);
    expect(ref.current).toBeNull();
  });

  it("preserves controlled value updates through onChange", () => {
    const changed: string[] = [];
    function ControlledInput() {
      const [value, setValue] = useState("initial");
      return createElement(Component, {
        "aria-label": "Query", value,
        onChange: (event) => { changed.push(event.currentTarget.value); setValue(event.currentTarget.value); },
      });
    }
    render(createElement(ControlledInput));
    const input = host.querySelector("input")!;
    type(input, "updated");
    expect(changed).toEqual(["updated"]);
    expect(input.value).toBe("updated");
  });

  it("preserves native disabled behavior and excludes disabled values from form data", () => {
    const onClick = vi.fn();
    render(createElement("form", null, createElement(Component, {
      type: "checkbox", name: "selected", defaultChecked: true, disabled: true, onClick,
      "aria-label": "Selected",
    })));
    const input = host.querySelector("input")!;
    expect(input.disabled).toBe(true);
    click(input);
    act(() => input.focus());
    expect(input.checked).toBe(true);
    expect(onClick).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
    expect(new FormData(host.querySelector("form")!).has("selected")).toBe(false);
  });

  it("accepts an external label by id without adding an implicit label", () => {
    render(createElement(Fragment, null,
      createElement("label", { htmlFor: "query" }, "Find records"),
      createElement(Component, { id: "query", name: "query", type: "search" }),
    ));
    const input = host.querySelector("input")!;
    const label = host.querySelector("label")!;
    expect(input.type).toBe("search");
    expect(Array.from(input.labels ?? [])).toEqual([label]);
    expect(label.control).toBe(input);
  });
});

describe("Field and SearchInput composition", () => {
  it("associates Field's visible label with its nested native input and activates it", () => {
    render(createElement(Field, {
      label: "Send updates", className: "fixture-field",
      children: createElement(Input, { type: "checkbox", id: "updates" }),
    }));
    const label = host.querySelector("label")!;
    const input = host.querySelector("input")!;
    expect(label.textContent).toBe("Send updates");
    expect(label.classList.contains("fixture-field")).toBe(true);
    expect(label.control).toBe(input);
    expect(Array.from(input.labels ?? [])).toEqual([label]);
    click(label);
    expect(input.checked).toBe(true);
  });

  it("associates a Field with SearchInput without nesting labels", () => {
    render(createElement(Field, {
      label: "Find bots", children: createElement(SearchInput, { name: "bots" }),
    }));
    const input = host.querySelector("input")!;
    const label = host.querySelector("label")!;
    expect(host.querySelector("label label")).toBeNull();
    expect(host.querySelectorAll("label")).toHaveLength(1);
    expect(label.textContent).toBe("Find bots");
    expect(label.control).toBe(input);
    expect(Array.from(input.labels ?? [])).toEqual([label]);
  });

  it("reserves left padding for the decorative search icon without intercepting the input", () => {
    render(createElement(SearchInput, { "aria-label": "Find bots", className: "fixture-search" }));
    const input = host.querySelector("input")!;
    const icon = host.querySelector("svg")!;
    expect(input.classList.contains("pl-6")).toBe(true);
    expect(input.classList.contains("fixture-search")).toBe(true);
    expect(icon.getAttribute("aria-hidden")).toBe("true");
    expect(icon.getAttribute("width")).toBe("12");
    expect(icon.classList.contains("left-2")).toBe(true);
    expect(icon.classList.contains("pointer-events-none")).toBe(true);
    expect(icon.parentElement).toBe(input.parentElement);
    expect(input.parentElement!.classList.contains("relative")).toBe(true);
  });
});

describe("Card", () => {
  it("preserves native elements, heading semantics, props, refs and composed classes for each component", () => {
    const card = createRef<HTMLDivElement>();
    const header = createRef<HTMLDivElement>();
    const title = createRef<HTMLHeadingElement>();
    const description = createRef<HTMLParagraphElement>();
    const content = createRef<HTMLDivElement>();
    const footer = createRef<HTMLDivElement>();
    const onClick = vi.fn();
    const props = { className: "fixture-card p-8", title: "Details", tabIndex: 0, onClick, "aria-label": "Details" };
    render(createElement(Fragment, null,
      createElement(Card, { ...props, ref: card, id: "card", role: "region", "aria-labelledby": "card-title" }, "Card"),
      createElement(CardHeader, { ...props, ref: header, id: "header" }, "Header"),
      createElement(CardTitle, { ...props, ref: title, id: "card-title" }, "Card heading"),
      createElement(CardDescription, { ...props, ref: description, id: "description" }, "Description"),
      createElement(CardContent, { ...props, ref: content, id: "content" }, "Content"),
      createElement(CardFooter, { ...props, ref: footer, id: "footer" }, "Footer"),
    ));
    const components = [
      [card, "DIV", "card", "eac-card"],
      [header, "DIV", "header", "eac-card-header"],
      [title, "H2", "card-title", "eac-card-title"],
      [description, "P", "description", "eac-card-description"],
      [content, "DIV", "content", "eac-card-content"],
      [footer, "DIV", "footer", "eac-card-footer"],
    ] as const;
    for (const [ref, tag, id, marker] of components) {
      const element = host.querySelector(`#${id}`)! as HTMLElement;
      expect(ref.current).toBe(element);
      expect(element.tagName).toBe(tag);
      expect(element.title).toBe("Details");
      expect(element.tabIndex).toBe(0);
      expect(element.getAttribute("aria-label")).toBe("Details");
      expect(element.classList.contains(marker)).toBe(true);
      expect(element.classList.contains("fixture-card")).toBe(true);
      expect(element.classList.contains("p-8")).toBe(true);
      expect(element.classList.contains("p-3")).toBe(false);
      click(element);
    }
    expect(onClick).toHaveBeenCalledTimes(6);
    expect(card.current!.getAttribute("role")).toBe("region");
    expect(card.current!.getAttribute("aria-labelledby")).toBe(title.current!.id);
    expect(title.current!.textContent).toBe("Card heading");
    render(null);
    for (const [ref] of components) expect(ref.current).toBeNull();
  });
});

describe("Badge", () => {
  it("defaults to the neutral tone", () => {
    render(createElement(Badge, null, "Ready"));
    expect(host.querySelector("span")!.classList.contains("eac-badge-neutral")).toBe(true);
  });

  it.each(["neutral", "accent", "success", "warning", "danger", "outline"] as const)(
    "retains the %s tone while forwarding native span props and refs", (tone) => {
      const ref = createRef<HTMLSpanElement>();
      const onClick = vi.fn();
      render(createElement(Badge, {
        tone, ref, id: "status", role: "status", "aria-live": "polite", title: "Bot status",
        className: "fixture-badge px-5", onClick,
      }, "Ready"));
      const badge = host.querySelector("span")!;
      expect(ref.current).toBe(badge);
      expect(badge.id).toBe("status");
      expect(badge.title).toBe("Bot status");
      expect(badge.textContent).toBe("Ready");
      expect(badge.getAttribute("role")).toBe("status");
      expect(badge.getAttribute("aria-live")).toBe("polite");
      expect(badge.classList.contains("eac-badge")).toBe(true);
      expect(badge.classList.contains(`eac-badge-${tone}`)).toBe(true);
      expect(badge.classList.contains("fixture-badge")).toBe(true);
      expect(badge.classList.contains("px-5")).toBe(true);
      expect(badge.classList.contains("px-2")).toBe(false);
      expect(badge.hasAttribute("tone")).toBe(false);
      click(badge);
      expect(onClick).toHaveBeenCalledOnce();
      render(null);
      expect(ref.current).toBeNull();
    },
  );
});
