import { createContext, useContext, useState, type ReactNode } from "react";

interface SettingsFooterContextValue {
  footerEl: HTMLDivElement | null;
  setFooterEl: (el: HTMLDivElement | null) => void;
}

const SettingsFooterContext = createContext<SettingsFooterContextValue>({
  footerEl: null,
  setFooterEl: () => {},
});

export function SettingsFooterProvider({ children }: { children: ReactNode }) {
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);
  return (
    <SettingsFooterContext.Provider value={{ footerEl, setFooterEl }}>
      {children}
    </SettingsFooterContext.Provider>
  );
}

export function useSettingsFooterEl() {
  return useContext(SettingsFooterContext).footerEl;
}

export function useSettingsFooterSetter() {
  return useContext(SettingsFooterContext).setFooterEl;
}

export function SettingsFooterMount() {
  const setFooterEl = useSettingsFooterSetter();
  return <div ref={setFooterEl} />;
}
