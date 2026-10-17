/**
 * Server-render tests for the shared UI primitives (no DOM environment in this
 * repo — see integrations/render-smoke.test.ts). They pin the contracts other
 * pages rely on: labelled controls, announced errors, 44px phone floors, the
 * persistent toast live regions, and class overrides that actually override.
 */
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";
import { Button, buttonClass } from "./button";
import { ButtonLink } from "./button-link";
import { CardTitle } from "./card";
import { ConfirmDialog, describeError } from "./confirm-dialog";
import { CopyButton, CopyValue } from "./copy-button";
import { DataListStatic } from "./data-list-static";
import { TD } from "./data-table";
import { Field } from "./field";
import { IconButton } from "./icon-button";
import { InlineAlert } from "./inline-alert";
import { Input } from "./input";
import { SegmentedControl } from "./segmented-control";
import { Select } from "./select";
import { ShowOncePanel } from "./show-once-panel";
import { LoadingStatus } from "./skeleton";
import { Textarea } from "./textarea";
import { ToastProvider } from "./toast";

// createElement with the children passed positionally, loosely typed: the primitives declare
// `children` as a required prop, which createElement's overloads cannot see through varargs.
const h = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): ReactElement =>
  createElement(type as never, props as never, ...(children as never[]));
const html = (el: ReactElement) => renderToStaticMarkup(el);
const classOf = (markup: string) => /class="([^"]*)"/.exec(markup)?.[1] ?? "";

describe("Button", () => {
  it("floors sm and md at 44px below sm via min-height, keeping the compact desktop heights", () => {
    const sm = classOf(html(h(Button, { size: "sm" }, "x")));
    const md = classOf(html(h(Button, { size: "md" }, "x")));
    expect(sm).toContain("h-8");
    expect(sm).toContain("max-sm:min-h-11");
    expect(md).toContain("h-10");
    expect(md).toContain("max-sm:min-h-11");
    expect(classOf(html(h(Button, { size: "lg" }, "x")))).toContain("h-12");
  });

  it("a caller's own height override cannot shrink the phone floor (min-height survives)", () => {
    const cls = classOf(html(h(Button, { size: "md", className: "h-9 text-xs" }, "x")));
    expect(cls).toContain("h-9");
    expect(cls).not.toContain("h-10");
    expect(cls).toContain("max-sm:min-h-11");
  });

  it("a tone override replaces the variant's text colour instead of losing to CSS order", () => {
    const cls = classOf(html(h(Button, { variant: "ghost", className: "text-danger-ink hover:bg-danger/10" }, "x")));
    expect(cls).toContain("text-danger-ink");
    expect(cls).not.toContain("text-ink-secondary");
    expect(cls).toContain("hover:bg-danger/10");
    expect(cls).not.toContain("hover:bg-sunken");
  });

  it("primary pairs the accent fill with accent-ink, never text-white", () => {
    const cls = classOf(html(h(Button, null, "x")));
    expect(cls).toContain("bg-accent");
    expect(cls).toContain("text-accent-ink");
    expect(cls).not.toContain("text-white");
  });

  it("uses the shared solid focus ring", () => {
    expect(classOf(html(h(Button, null, "x")))).toContain("focus-ring");
  });
});

describe("ButtonLink / buttonClass", () => {
  it("renders an anchor with the Button recipe", () => {
    const markup = html(h(ButtonLink, { href: "/dashboard", variant: "secondary", size: "sm" }, "Back"));
    expect(markup).toMatch(/^<a /);
    expect(markup).toContain('href="/dashboard"');
    const cls = classOf(markup);
    expect(cls).toContain("max-sm:min-h-11");
    expect(cls).toContain("focus-ring");
    expect(cls).toContain("bg-surface");
  });

  it("buttonClass is the same string Button renders", () => {
    expect(classOf(html(h(Button, { variant: "danger", size: "sm" }, "x")))).toBe(
      buttonClass({ variant: "danger", size: "sm" }),
    );
  });
});

describe("IconButton", () => {
  const markup = html(h(IconButton, { label: "Close" }, h("svg", null)));

  it("takes its accessible name from the required label and never submits a form", () => {
    expect(markup).toContain('aria-label="Close"');
    expect(markup).toContain('type="button"');
  });

  it("is 44px below lg and 40px from lg (md) / 44px below sm and 32px from sm (sm)", () => {
    expect(classOf(markup)).toContain("h-11 w-11 lg:h-10 lg:w-10");
    expect(classOf(html(h(IconButton, { label: "x", size: "sm" }, "i")))).toContain("h-11 w-11 sm:h-8 sm:w-8");
  });

  it("forwards pressed/expanded state", () => {
    const m = html(h(IconButton, { label: "x", "aria-pressed": true, "aria-expanded": false }, "i"));
    expect(m).toContain('aria-pressed="true"');
    expect(m).toContain('aria-expanded="false"');
  });
});

describe("Field", () => {
  const withInput = (props: Record<string, unknown>) =>
    html(
      h(Field, {
        label: "Project name",
        ...props,
        children: (a11y: Record<string, unknown>) => h(Input, a11y),
      }),
    );

  it("wires the label to the control with a generated id", () => {
    const markup = withInput({});
    const forId = /<label[^>]*\sfor="([^"]+)"/.exec(markup)?.[1];
    expect(forId).toBeTruthy();
    expect(markup).toContain(`id="${forId}"`);
  });

  it("describes the control by the hint, and announces + describes by the error when there is one", () => {
    const hinted = withInput({ hint: "Shown on every report" });
    const hintId = /aria-describedby="([^"]+)"/.exec(hinted)?.[1];
    expect(hintId).toBeTruthy();
    expect(hinted).toContain(`<p id="${hintId}"`);
    expect(hinted).toContain('aria-invalid="false"');

    const errored = withInput({ hint: "Shown on every report", error: "Name is required" });
    expect(errored).toContain('aria-invalid="true"');
    const errId = /aria-describedby="([^"]+)"/.exec(errored)?.[1];
    expect(errored).toContain(`<p id="${errId}" role="alert"`);
    expect(errored).toContain("Name is required");
    expect(errored).not.toContain("Shown on every report"); // the error replaces the hint
  });

  it("marks required controls (aria-required) with a decorative asterisk, optional with text", () => {
    const required = withInput({ required: true });
    expect(required).toContain('aria-required="true"');
    expect(required).toMatch(/<span aria-hidden="true"[^>]*>\*<\/span>/);
    expect(withInput({ optional: true })).toContain("(optional)");
  });

  it("two fields on a page never share an id", () => {
    const both = html(
      h("div", null,
        h(Field, { label: "A", children: (a: Record<string, unknown>) => h(Input, a as never) } as never),
        h(Field, { label: "B", children: (a: Record<string, unknown>) => h(Input, a as never) } as never),
      ),
    );
    const ids = [...both.matchAll(/<input[^>]*\sid="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
  });
});

describe("Select / Textarea", () => {
  it("use the solid focus ring, 44px phone floor (Select) and the field utility", () => {
    const select = classOf(html(h(Select, null, h("option", null, "a"))));
    expect(select).toContain("focus-ring");
    expect(select).toContain("h-11");
    expect(select).toContain("sm:h-10");
    expect(select).toContain("field");
    const textarea = classOf(html(h(Textarea, { rows: 3 })));
    expect(textarea).toContain("focus-ring");
    expect(textarea).toContain("field");
    expect(textarea).not.toMatch(/ring-accent\/\d+/);
  });

  it("a caller's sm: height replaces the primitive's (no 40px-vs-36px mismatch in a toolbar)", () => {
    const cls = classOf(html(h(Select, { className: "sm:h-9" })));
    expect(cls).toContain("sm:h-9");
    expect(cls).not.toContain("sm:h-10");
    expect(cls).toContain("h-11");
  });
});

describe("InlineAlert", () => {
  it("announces danger assertively and everything else politely", () => {
    expect(html(h(InlineAlert, null, "Boom"))).toContain('role="alert"');
    for (const tone of ["success", "warning", "neutral"] as const) {
      expect(html(h(InlineAlert, { tone }, "ok"))).toContain('role="status"');
    }
  });

  it("uses -ink text on the tint", () => {
    expect(classOf(html(h(InlineAlert, null, "x")))).toContain("text-danger-ink");
    expect(classOf(html(h(InlineAlert, { tone: "warning" }, "x")))).toContain("text-warning-ink");
  });
});

describe("ShowOncePanel", () => {
  const markup = html(h(ShowOncePanel, { title: "Your token", onDismiss: () => {} }, h("code", null, "npm_secret")));

  it("is a labelled section whose heading can take focus on mount", () => {
    const headingId = /aria-labelledby="([^"]+)"/.exec(markup)?.[1];
    expect(headingId).toBeTruthy();
    expect(markup).toMatch(new RegExp(`<h4 id="${headingId}"[^>]*tabindex="-1"`));
  });

  it("warns that it is shown once and ends in an acknowledge button", () => {
    expect(markup).toContain("Shown once");
    expect(markup).toContain("saved it");
    expect(markup).toContain("npm_secret");
  });
});

describe("CopyButton / CopyValue", () => {
  it("names what is copied and keeps a persistent polite live region", () => {
    const markup = html(h(CopyButton, { value: "https://x", subject: "webhook URL" }));
    expect(markup).toContain('aria-label="Copy webhook URL"');
    expect(markup).toMatch(/<span role="status" aria-live="polite" class="sr-only">/);
  });

  it("CopyValue shows a labelled select-all value next to the button", () => {
    const markup = html(h(CopyValue, { label: "Feed URL", value: "https://x/feed", subject: "feed URL" }));
    expect(markup).toContain("Feed URL");
    expect(markup).toContain("select-all");
    expect(markup).toContain('aria-label="Copy feed URL"');
  });
});

describe("ConfirmDialog", () => {
  const markup = html(
    h(ConfirmDialog, {
      heading: "Revoke the feed?",
      confirmLabel: "Revoke",
      failureFallback: "Could not revoke.",
      onConfirm: async () => {},
    }, h("p", null, "Anyone using the link loses access.")),
  );

  it("renders the heading, the body and a Cancel + confirm pair", () => {
    expect(markup).toContain("Revoke the feed?");
    expect(markup).toContain("Anyone using the link loses access.");
    expect(markup).toContain("Cancel");
    expect(markup).toContain("Revoke");
  });

  it("the danger confirm uses the danger variant (solid fill, white text)", () => {
    expect(markup).toContain("bg-danger-solid");
  });

  it("describeError prefers the error message and appends API field errors", () => {
    expect(describeError(new Error("Nope"), "fallback")).toBe("Nope");
    expect(describeError("weird", "fallback")).toBe("fallback");
    const e = Object.assign(new Error("Invalid"), { fields: [{ field: "name", message: "too short" }, { bad: 1 }] });
    expect(describeError(e, "fallback")).toBe("Invalid (name: too short)");
  });
});

describe("ToastProvider — persistent live regions", () => {
  const markup = html(h(ToastProvider, null, h("main", null, "page")));

  it("mounts a polite status region and an assertive alert region before any toast exists", () => {
    expect(markup).toMatch(/<div role="status" aria-live="polite" aria-atomic="true" class="sr-only">/);
    expect(markup).toMatch(/<div role="alert" aria-live="assertive" aria-atomic="true" class="sr-only">/);
  });
});

describe("Badge", () => {
  it("has an ink-text tint tone for every status hue", () => {
    for (const [tone, hue] of [
      ["info", "info"],
      ["success", "success"],
      ["warning", "warning"],
      ["sev-high", "sev-high"],
      ["danger", "danger"],
      ["change", "change"],
    ] as const) {
      const cls = classOf(html(h(Badge, { tone }, "x")));
      expect(cls).toContain(`bg-${hue}/15`);
      expect(cls).toContain(`text-${hue}-ink`);
    }
  });
});

describe("SegmentedControl", () => {
  const markup = html(
    h(SegmentedControl, {
      label: "View",
      value: "a",
      onChange: () => {},
      options: [{ value: "a", label: "A" }, { value: "b", label: "B" }],
      size: "sm",
    }),
  );

  it("stays an accessible radiogroup with roving tabindex", () => {
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain('aria-label="View"');
    expect(markup).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*tabindex="0"/);
    expect(markup).toMatch(/aria-checked="false"[^>]*tabindex="-1"/);
  });

  it("segments are 44px tall below sm (the 28px chips on /approvals) and compact from sm", () => {
    expect(markup).toContain("h-11");
    expect(markup).toContain("sm:h-7");
  });
});

describe("CardTitle / TD / LoadingStatus", () => {
  it("CardTitle is an h2 by default (a console page has one h1) and can step down", () => {
    expect(html(h(CardTitle, null, "t"))).toMatch(/^<h2 /);
    expect(html(h(CardTitle, { as: "h3" }, "t"))).toMatch(/^<h3 /);
  });

  it("numeric table cells never wrap", () => {
    const cls = classOf(html(h("table", null, h("tbody", null, h("tr", null, h(TD, { numeric: true }, "1,200"))))));
    expect(cls).toContain("whitespace-nowrap");
    expect(cls).toContain("tabular-nums");
  });

  it("LoadingStatus is a screen-reader-only status", () => {
    const markup = html(h(LoadingStatus, { label: "risks" }));
    expect(markup).toContain('role="status"');
    expect(markup).toContain("sr-only");
    expect(markup).toContain("Loading risks");
  });
});

describe("DataListStatic (server-component DataList)", () => {
  type Row = { id: string; title: string; status: string; owner: string };
  const rows: Row[] = [{ id: "r1", title: "A very long risk title that should wrap onto a second line rather than being cut off", status: "open", owner: "Sam" }];
  const columns = [
    { key: "title", header: "Title", cell: (r: Row) => r.title, primary: true },
    { key: "status", header: "Status", cell: (r: Row) => h(Badge, { tone: "info" }, r.status), badge: true },
    { key: "owner", header: "Owner", cell: (r: Row) => r.owner },
  ];
  const markup = html(h(DataListStatic, { columns, rows, rowKey: (r: Row) => r.id, href: (r: Row) => `/risks/${r.id}` }));

  it("renders without hooks or handlers (a server page can pass it function props)", () => {
    expect(markup).toContain("<table");
    expect(markup).toContain("Title");
    expect(markup).not.toContain("role=\"button\"");
  });

  it("rows are real links: a stretched link in the primary cell at md+, the whole card below md", () => {
    expect([...markup.matchAll(/<a [^>]*href="\/risks\/r1"/g)]).toHaveLength(2);
    expect(markup).toContain("after:absolute after:inset-0");
  });

  it("card titles wrap to two lines instead of truncating", () => {
    expect(markup).toContain("line-clamp-2");
    expect(markup).not.toMatch(/truncate[^"]*text-sm font-medium text-ink/);
  });

  it("renders the empty slot when there are no rows, and plain cards when no href is given", () => {
    expect(html(h(DataListStatic, { columns, rows: [], rowKey: (r: Row) => r.id, empty: h("p", null, "Nothing here") }))).toBe("<p>Nothing here</p>");
    expect(html(h(DataListStatic, { columns, rows, rowKey: (r: Row) => r.id }))).not.toContain("<a ");
  });
});
