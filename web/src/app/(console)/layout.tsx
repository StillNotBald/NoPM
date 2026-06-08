import { AppShell } from "@/components/layout/app-shell";
import { ModalProvider } from "@/components/ui/modal";

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <ModalProvider>
      <AppShell>{children}</AppShell>
    </ModalProvider>
  );
}
