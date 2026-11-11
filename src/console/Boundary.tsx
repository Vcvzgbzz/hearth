/** A render that throws shows its error in place of what it was drawing, so the rest of the console keeps working. */
import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button, Card, cx, mono } from "./ui.js";

type State = { error: Error | null };

export class Boundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };
  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("hearth console: a page failed to render", error, info.componentStack);
  }
  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="p-5">
        <Card className="p-5">
          <div className="font-semibold">This page hit an error</div>
          <p className="mt-1 text-dim">The rest of the console still works; the browser&rsquo;s console has the details.</p>
          <pre className={cx(mono, "mt-3 whitespace-pre-wrap break-all text-bad")}>{error.message}</pre>
          <div className="mt-4 flex gap-2">
            <Button onClick={() => this.setState({ error: null })}>try again</Button>
            <Button onClick={() => location.reload()}>reload</Button>
          </div>
        </Card>
      </div>
    );
  }
}
