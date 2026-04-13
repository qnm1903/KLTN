import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// Mock window.alert for jsdom (not natively implemented)
globalThis.alert = vi.fn();
