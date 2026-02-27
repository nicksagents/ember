import { Header } from "@/components/header";
import { SettingsForm } from "@/components/settings-form";

export default function SettingsPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <Header title="Ember Settings" showBack />
      <div className="flex-1 overflow-y-auto">
        <SettingsForm />
      </div>
    </div>
  );
}
