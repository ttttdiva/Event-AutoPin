import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { getEventDashboard } from './database';
import type { BudgetSummary } from './types';
import { beginSqlMetricsScope, recordUiMetric } from './performance';
import { createLoadEpochGuard } from './event-load-epoch';

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
  refreshStats: (eventId?: number | null) => void;
  stats: EventStats;
  budget: BudgetSummary;
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
  refreshStats: () => {},
  stats: { totalCircles: 0, boughtCircles: 0, couldntBuyCircles: 0, skippedCircles: 0, remainingCircles: 0 },
  budget: emptyBudget,
});

export function EventProvider({ children }: { children: React.ReactNode }) {
  recordUiMetric('event-root-render');
  const [currentEventId, setCurrentEventIdState] = useState<number | null>(null);
  const [stats, setStats] = useState<EventStats>({
    totalCircles: 0, boughtCircles: 0, couldntBuyCircles: 0, skippedCircles: 0, remainingCircles: 0,
  });
  const [budget, setBudget] = useState<BudgetSummary>(emptyBudget);
  const currentEventIdRef = useRef<number | null>(null);
  const dashboardEpochRef = useRef(createLoadEpochGuard());

  const setCurrentEventId = useCallback((id: number | null) => {
    if (currentEventIdRef.current !== id) {
      // Clear the previous event synchronously. This prevents one frame of
      // stale stats/budget while the new dashboard query is in flight.
      dashboardEpochRef.current.next();
      setStats({ totalCircles: 0, boughtCircles: 0, couldntBuyCircles: 0, skippedCircles: 0, remainingCircles: 0 });
      setBudget(emptyBudget);
    }
    currentEventIdRef.current = id;
    setCurrentEventIdState(id);
  }, []);

  const refreshStats = useCallback((eventId?: number | null) => {
    const activeId = currentEventIdRef.current;
    const targetId = eventId ?? activeId;
    // A stale expanded row from a previous route must not invalidate the
    // current event's dashboard request.
    if (!targetId || targetId !== activeId) return;
    const epoch = dashboardEpochRef.current.next();
    const endSqlMetrics = beginSqlMetricsScope();
    getEventDashboard(targetId).then((dashboard) => {
      // 画面遷移中に古いイベントの結果を反映しない。
      if (
        targetId !== currentEventIdRef.current ||
        !dashboardEpochRef.current.isCurrent(epoch)
      ) return;
      setStats(dashboard.stats);
      setBudget(dashboard.budget);
    }).finally(() => {
      const snapshot = endSqlMetrics();
      recordUiMetric('event-dashboard-sql-count', snapshot.count);
      recordUiMetric('event-dashboard-sql-elapsed-ms', snapshot.elapsedMs);
    });
  }, []);

  useEffect(() => {
    if (currentEventId) {
      const targetId = currentEventId;
      const epoch = dashboardEpochRef.current.next();
      const endSqlMetrics = beginSqlMetricsScope();
      getEventDashboard(targetId).then((dashboard) => {
        if (
          targetId !== currentEventIdRef.current ||
          !dashboardEpochRef.current.isCurrent(epoch)
        ) return;
        setStats(dashboard.stats);
        setBudget(dashboard.budget);
      }).finally(() => {
        const snapshot = endSqlMetrics();
        recordUiMetric('event-dashboard-sql-count', snapshot.count);
        recordUiMetric('event-dashboard-sql-elapsed-ms', snapshot.elapsedMs);
      });
    } else {
      setStats({ totalCircles: 0, boughtCircles: 0, couldntBuyCircles: 0, skippedCircles: 0, remainingCircles: 0 });
      setBudget(emptyBudget);
    }
  }, [currentEventId]);

  return (
    <EventContext.Provider value={{
      currentEventId, setCurrentEventId,
      refreshStats,
      stats, budget,
    }}>
      {children}
    </EventContext.Provider>
  );
}

export function useEvent() {
  return useContext(EventContext);
}
