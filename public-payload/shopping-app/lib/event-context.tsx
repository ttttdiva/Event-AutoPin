import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { getEventStats, getBudgetSummary, getEvent } from './database';
import type { BudgetSummary } from './types';

interface EventStats {
  totalCircles: number;
  boughtCircles: number;
  couldntBuyCircles: number;
  skippedCircles: number;
  remainingCircles: number;
}

export type ViewMode = 'list' | 'split' | 'map';

interface EventContextType {
  currentEventId: number | null;
  setCurrentEventId: (id: number | null) => void;
  expandedEventId: number | null;
  setExpandedEventId: (id: number | null) => void;
  expandedCircleId: number | null;
  setExpandedCircleId: (id: number | null) => void;
  viewMode: ViewMode;
  setViewMode: (mode: ViewMode) => void;
  refreshKey: number;
  refresh: () => void;
  refreshStats: () => void;
  stats: EventStats;
  budget: BudgetSummary;
  isShoppingMode: boolean;
  shoppingStartedAt: string | null;
}

const emptyBudget: BudgetSummary = {
  totalListPrice: 0,
  totalPlanned: 0,
  totalBought: 0,
  totalCouldntBuy: 0,
  totalSkipped: 0,
  totalRemaining: 0,
  byPriority: [],
};

const EventContext = createContext<EventContextType>({
  currentEventId: null,
  setCurrentEventId: () => {},
  expandedEventId: null,
  setExpandedEventId: () => {},
  expandedCircleId: null,
  setExpandedCircleId: () => {},
  viewMode: 'list',
  setViewMode: () => {},
  refreshKey: 0,
  refresh: () => {},
  refreshStats: () => {},
  stats: { totalCircles: 0, boughtCircles: 0, couldntBuyCircles: 0, skippedCircles: 0, remainingCircles: 0 },
  budget: emptyBudget,
  isShoppingMode: false,
  shoppingStartedAt: null,
});

export function EventProvider({ children }: { children: React.ReactNode }) {
  const [currentEventId, setCurrentEventId] = useState<number | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<number | null>(null);
  const [expandedCircleId, setExpandedCircleId] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [refreshKey, setRefreshKey] = useState(0);
  const [stats, setStats] = useState<EventStats>({
    totalCircles: 0, boughtCircles: 0, couldntBuyCircles: 0, skippedCircles: 0, remainingCircles: 0,
  });
  const [budget, setBudget] = useState<BudgetSummary>(emptyBudget);
  const [isShoppingMode, setIsShoppingMode] = useState(false);
  const [shoppingStartedAt, setShoppingStartedAt] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setRefreshKey((k) => k + 1);
  }, []);

  const refreshStats = useCallback(() => {
    if (currentEventId) {
      getEventStats(currentEventId).then(setStats);
      getBudgetSummary(currentEventId).then(setBudget);
    }
  }, [currentEventId]);

  useEffect(() => {
    if (currentEventId) {
      getEventStats(currentEventId).then(setStats);
      getBudgetSummary(currentEventId).then(setBudget);
      getEvent(currentEventId).then((ev) => {
        if (ev) {
          const active = ev.shoppingStartedAt != null && ev.shoppingEndedAt == null;
          setIsShoppingMode(active);
          setShoppingStartedAt(ev.shoppingStartedAt);
        }
      });
    } else {
      setStats({ totalCircles: 0, boughtCircles: 0, couldntBuyCircles: 0, skippedCircles: 0, remainingCircles: 0 });
      setBudget(emptyBudget);
      setIsShoppingMode(false);
      setShoppingStartedAt(null);
    }
  }, [currentEventId, refreshKey]);

  return (
    <EventContext.Provider value={{
      currentEventId, setCurrentEventId,
      expandedEventId, setExpandedEventId,
      expandedCircleId, setExpandedCircleId,
      viewMode, setViewMode,
      refreshKey, refresh, refreshStats,
      stats, budget, isShoppingMode, shoppingStartedAt,
    }}>
      {children}
    </EventContext.Provider>
  );
}

export function useEvent() {
  return useContext(EventContext);
}
