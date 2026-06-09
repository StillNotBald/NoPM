import { AppShell } from "@/components/layout/app-shell";
import { ModalProvider } from "@/components/ui/modal";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <ModalProvider>
      {/* ToastProvider is mounted inside AppShell (wraps the inspector + all console content). */}
      <AppShell>{children}</AppShell>
    </ModalProvider>
  );
}
