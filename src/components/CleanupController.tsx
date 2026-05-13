'use client';

import { useEffect } from 'react';
import { startBackgroundCleanup, stopBackgroundCleanup } from '@/lib/attendance';

export default function CleanupController() {
  useEffect(() => {
    startBackgroundCleanup();
    return () => {
      stopBackgroundCleanup();
    };
  }, []);

  return null;
}
