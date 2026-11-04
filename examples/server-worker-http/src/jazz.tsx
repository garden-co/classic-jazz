import { JazzReactProvider } from "jazz-tools/react";
import { syncServer } from "./syncServer";
import { JazzInspector } from "jazz-tools/inspector";

export function Jazz({ children }: { children: React.ReactNode }) {
  return (
    <JazzReactProvider
      enableSSR
      sync={{
        peer: syncServer,
      }}
    >
      <JazzInspector />
      {children}
    </JazzReactProvider>
  );
}
