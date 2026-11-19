import { Component, type ReactNode } from 'react'

/** If a screen crashes, show a way back instead of a blank white page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    console.error(error)
  }

  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className="grid min-h-dvh place-items-center bg-bg p-8 text-center text-ink">
        <div>
          <p className="text-[17px] font-semibold">Something went wrong</p>
          <p className="mt-1 text-[14px] text-ink-2">Your data is safe. Reload to carry on.</p>
          <button onClick={() => location.reload()} className="press mt-5 h-11 rounded-2xl bg-accent px-5 font-semibold text-white">
            Reload
          </button>
        </div>
      </div>
    )
  }
}
