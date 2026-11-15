// Minimal render helper. @testing-library/react needs its peer @testing-library/dom, which isn't installed,
// so UI tests mount with react-dom/client + act and query the real DOM.
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface Rendered {
  container: HTMLElement;
  root: Root;
  text: () => string;
  byTestId: (id: string) => HTMLElement | null;
  byRole: (role: string) => HTMLElement[];
  byText: (needle: string | RegExp) => HTMLElement | null;
  unmount: () => void;
}

export function render(ui: ReactElement): Rendered {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    root,
    text: () => container.textContent ?? "",
    byTestId: (id) => container.querySelector(`[data-testid="${id}"]`),
    byRole: (role) => {
      const implicit: Record<string, string> = { button: "button", link: "a[href]" };
      const sel = [`[role="${role}"]`, implicit[role]].filter(Boolean).join(",");
      return Array.from(container.querySelectorAll<HTMLElement>(sel));
    },
    byText: (needle) => {
      const all = Array.from(container.querySelectorAll<HTMLElement>("*"));
      return (
        all.find((el) =>
          Array.from(el.childNodes).some(
            (n) => n.nodeType === 3 && (typeof needle === "string" ? (n.textContent ?? "").includes(needle) : needle.test(n.textContent ?? "")),
          ),
        ) ?? null
      );
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

export { act };
