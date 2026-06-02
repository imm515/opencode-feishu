export type SectionInput =
  | { type: "markdown"; content?: string }
  | { type: "divider" }
  | { type: "note"; content?: string }
  | { type: "actions"; buttons?: readonly { text: string; value: string; style?: "primary" | "default" | "danger" }[] }
  | { type: "collapse"; title?: string; content?: string }

export interface CardArgs {
  title: string
  template?: "blue" | "green" | "orange" | "red" | "purple" | "grey"
  sections: readonly SectionInput[]
}

export function buildCardFromDSL(args: CardArgs): object {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: args.title },
      template: args.template ?? "blue",
    },
    body: {
      elements: args.sections.flatMap((s) => {
        switch (s.type) {
          case "divider":
            return { tag: "hr" }
          case "note":
            return { tag: "div", text: { tag: "plain_text", content: s.content ?? "" } }
          case "actions":
            if (!s.buttons?.length) return []
            return {
              tag: "column_set",
              flex_mode: "none",
              background_style: "default",
              columns: s.buttons.map((btn) => ({
                tag: "column",
                width: "weighted",
                weight: 1,
                elements: [{
                  tag: "button",
                  text: { tag: "plain_text", content: btn.text },
                  type: btn.style ?? "default",
                  value: btn.value,
                }],
              })),
            }
          case "collapse":
            return {
              tag: "collapsible_panel",
              expanded: false,
              header: { title: { tag: "plain_text", content: s.title ?? "" } },
              elements: [{ tag: "markdown", content: s.content ?? "" }],
            }
          case "markdown":
          default:
            return { tag: "markdown", content: s.content ?? "" }
        }
      }).filter(Boolean),
    },
  }
}