import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  getPriorityPaletteSetting,
  resetPriorityPaletteSetting,
  setPriorityPaletteSetting,
} from "./settings-store";
import {
  getPriorityColor,
  normalizePriorityPalette,
  priorityOptionsFromPalette,
  type PriorityPalette,
} from "./priority-colors";
import { PRIORITY_COLORS, type PriorityColorDefinition } from "./types";

type PriorityColorContextValue = {
  palette: PriorityPalette;
  options: ReturnType<typeof priorityOptionsFromPalette>;
  getColor: (priority: number) => PriorityColorDefinition;
  setColor: (priority: number, color: string) => Promise<boolean>;
  reset: () => Promise<void>;
  reload: () => Promise<void>;
};

const PriorityColorContext = createContext<PriorityColorContextValue | null>(null);

export function PriorityColorProvider({ children }: { children: ReactNode }) {
  const [palette, setPalette] = useState<PriorityPalette>(() =>
    normalizePriorityPalette(PRIORITY_COLORS),
  );

  const reload = useCallback(async () => {
    setPalette(await getPriorityPaletteSetting());
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const setColor = useCallback(
    async (priority: number, color: string) => {
      const next = await setPriorityPaletteSetting(priority, color);
      if (!next) return false;
      setPalette(next);
      return true;
    },
    [],
  );

  const reset = useCallback(async () => {
    const next = await resetPriorityPaletteSetting();
    setPalette(next);
  }, []);

  const value = useMemo<PriorityColorContextValue>(
    () => ({
      palette,
      options: priorityOptionsFromPalette(palette),
      getColor: (priority: number) => getPriorityColor(palette, priority),
      setColor,
      reset,
      reload,
    }),
    [palette, reload, reset, setColor],
  );

  return (
    <PriorityColorContext.Provider value={value}>
      {children}
    </PriorityColorContext.Provider>
  );
}

export function usePriorityColors() {
  const value = useContext(PriorityColorContext);
  if (!value) {
    throw new Error("usePriorityColors must be used inside PriorityColorProvider");
  }
  return value;
}
