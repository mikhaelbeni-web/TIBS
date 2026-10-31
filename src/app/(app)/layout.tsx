import { AppShell } from "@/components/AppShell";
import { RestaurantProvider } from "@/components/RestaurantProvider";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RestaurantProvider>
      <AppShell>{children}</AppShell>
    </RestaurantProvider>
  );
}
