/**
 * CSV Export Service Tests (Ticket #170)
 */

import { describe, it, expect } from 'vitest';
import {
  sanitizeCSVCell,
  sanitizeCSVRow,
  generateExportFilename,
  createKPISummaryRow,
  type KPIExportContext,
} from './csv-export.service.js';

describe('CSV Export Service', () => {
  describe('sanitizeCSVCell', () => {
    it('should return empty string for null and undefined', () => {
      expect(sanitizeCSVCell(null)).toBe('');
      expect(sanitizeCSVCell(undefined)).toBe('');
    });

    it('should prepend single quote to values starting with =', () => {
      expect(sanitizeCSVCell('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
      expect(sanitizeCSVCell('=cmd|calc')).toBe("'=cmd|calc");
    });

    it('should prepend single quote to values starting with +', () => {
      expect(sanitizeCSVCell('+123')).toBe("'+123");
      expect(sanitizeCSVCell('+cmd|calc')).toBe("'+cmd|calc");
    });

    it('should prepend single quote to values starting with -', () => {
      expect(sanitizeCSVCell('-456')).toBe("'-456");
      expect(sanitizeCSVCell('-cmd|calc')).toBe("'-cmd|calc");
    });

    it('should prepend single quote to values starting with @', () => {
      expect(sanitizeCSVCell('@SUM(A1)')).toBe("'@SUM(A1)");
      expect(sanitizeCSVCell('@cmd|calc')).toBe("'@cmd|calc");
    });

    it('should not modify safe values', () => {
      expect(sanitizeCSVCell('normal text')).toBe('normal text');
      expect(sanitizeCSVCell('123')).toBe('123');
      expect(sanitizeCSVCell('WO-12345')).toBe('WO-12345');
      expect(sanitizeCSVCell(42)).toBe('42');
      expect(sanitizeCSVCell(true)).toBe('true');
    });

    it('should handle strings that contain dangerous chars but do not start with them', () => {
      expect(sanitizeCSVCell('item = value')).toBe('item = value');
      expect(sanitizeCSVCell('total: +10')).toBe('total: +10');
      expect(sanitizeCSVCell('note: -5')).toBe('note: -5');
    });
  });

  describe('sanitizeCSVRow', () => {
    it('should sanitize all values in a row', () => {
      const row = {
        id: 'WO-123',
        formula: '=SUM(A1:A10)',
        safe: 'normal text',
        number: 42,
        dangerous: '+cmd|calc',
      };

      const sanitized = sanitizeCSVRow(row);

      expect(sanitized).toEqual({
        id: 'WO-123',
        formula: "'=SUM(A1:A10)",
        safe: 'normal text',
        number: '42',
        dangerous: "'+cmd|calc",
      });
    });

    it('should handle empty objects', () => {
      expect(sanitizeCSVRow({})).toEqual({});
    });

    it('should handle null and undefined values in rows', () => {
      const row = {
        a: null,
        b: undefined,
        c: 'value',
      };

      const sanitized = sanitizeCSVRow(row);

      expect(sanitized).toEqual({
        a: '',
        b: '',
        c: 'value',
      });
    });
  });

  describe('generateExportFilename', () => {
    it('should generate filename with KPI name only', () => {
      const context: KPIExportContext = {
        kpiName: 'Scrap Rate',
      };

      const filename = generateExportFilename(context);

      expect(filename).toMatch(/^arda-scrap-rate-\d{8}T\d+Z\.csv$/);
    });

    it('should generate filename with facility', () => {
      const context: KPIExportContext = {
        kpiName: 'Cycle Time',
        facilityId: 'fac-1',
        facilityName: 'Austin Warehouse',
      };

      const filename = generateExportFilename(context);

      expect(filename).toMatch(/^arda-cycle-time-facility-austin-warehouse-\d{8}T\d+Z\.csv$/);
    });

    it('should generate filename with date range', () => {
      const context: KPIExportContext = {
        kpiName: 'Throughput',
        dateFrom: '2024-01-01T00:00:00Z',
        dateTo: '2024-01-31T23:59:59Z',
      };

      const filename = generateExportFilename(context);

      expect(filename).toMatch(/^arda-throughput-2024-01-01-to-2024-01-31-\d{8}T\d+Z\.csv$/);
    });

    it('should generate filename with facility and date range', () => {
      const context: KPIExportContext = {
        kpiName: 'Queue Wait Time',
        facilityId: 'fac-2',
        facilityName: 'Dallas Plant',
        dateFrom: '2024-02-01T00:00:00Z',
        dateTo: '2024-02-29T23:59:59Z',
      };

      const filename = generateExportFilename(context);

      expect(filename).toMatch(/^arda-queue-wait-time-facility-dallas-plant-2024-02-01-to-2024-02-29-\d{8}T\d+Z\.csv$/);
    });

    it('should handle dateFrom only', () => {
      const context: KPIExportContext = {
        kpiName: 'Scrap Rate',
        dateFrom: '2024-01-01T00:00:00Z',
      };

      const filename = generateExportFilename(context);

      expect(filename).toMatch(/^arda-scrap-rate-from-2024-01-01-\d{8}T\d+Z\.csv$/);
    });

    it('should handle dateTo only', () => {
      const context: KPIExportContext = {
        kpiName: 'Scrap Rate',
        dateTo: '2024-01-31T23:59:59Z',
      };

      const filename = generateExportFilename(context);

      expect(filename).toMatch(/^arda-scrap-rate-to-2024-01-31-\d{8}T\d+Z\.csv$/);
    });

    it('should sanitize facility name for filesystem safety', () => {
      const context: KPIExportContext = {
        kpiName: 'Scrap Rate',
        facilityId: 'fac-1',
        facilityName: 'Austin & Dallas: Warehouse #1',
      };

      const filename = generateExportFilename(context);

      expect(filename).toMatch(/^arda-scrap-rate-facility-austin-dallas-warehouse-1-\d{8}T\d+Z\.csv$/);
    });

    it('should convert KPI name to kebab-case', () => {
      const context: KPIExportContext = {
        kpiName: 'Work Center Utilization Rate',
      };

      const filename = generateExportFilename(context);

      expect(filename).toMatch(/^arda-work-center-utilization-rate-\d{8}T\d+Z\.csv$/);
    });
  });

  describe('createKPISummaryRow', () => {
    it('should create summary rows from KPI values', () => {
      const kpiValues = {
        'Total Work Orders': 150,
        'Scrap Rate': '3.5%',
        'Cycle Time': 24.5,
      };

      const context: KPIExportContext = {
        kpiName: 'kpi-summary',
        facilityId: 'fac-1',
        facilityName: 'Austin',
        dateFrom: '2024-01-01T00:00:00Z',
        dateTo: '2024-01-31T23:59:59Z',
      };

      const rows = createKPISummaryRow(kpiValues, context);

      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        kpiName: 'Total Work Orders',
        kpiValue: 150,
        facilityId: 'fac-1',
        facilityName: 'Austin',
        dateFrom: '2024-01-01T00:00:00Z',
        dateTo: '2024-01-31T23:59:59Z',
      });
      expect(rows[0].exportedAt).toBeDefined();
      expect(rows[1].kpiName).toBe('Scrap Rate');
      expect(rows[1].kpiValue).toBe('3.5%');
      expect(rows[2].kpiName).toBe('Cycle Time');
      expect(rows[2].kpiValue).toBe(24.5);
    });

    it('should handle context without facility or dates', () => {
      const kpiValues = {
        'Total WOs': 100,
      };

      const context: KPIExportContext = {
        kpiName: 'kpi-summary',
      };

      const rows = createKPISummaryRow(kpiValues, context);

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kpiName: 'Total WOs',
        kpiValue: 100,
        facilityId: undefined,
        facilityName: undefined,
        dateFrom: undefined,
        dateTo: undefined,
      });
      expect(rows[0].exportedAt).toBeDefined();
    });

    it('should handle empty KPI values', () => {
      const kpiValues = {};

      const context: KPIExportContext = {
        kpiName: 'kpi-summary',
      };

      const rows = createKPISummaryRow(kpiValues, context);

      expect(rows).toHaveLength(0);
    });
  });
});
