import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import { PendingProvider } from "./pending/PendingProvider";
import { wagmiConfig } from "./lib/wagmi";
import "./styles.css";

const queryClient = new QueryClient();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Root element #root not found");

createRoot(rootElement).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <PendingProvider>
          <App />
        </PendingProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
