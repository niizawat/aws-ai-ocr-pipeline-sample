'use client';

import Box from '@mui/material/Box';
import { useTheme } from '@mui/material/styles';
import { BarChart, BarPlot } from '@mui/x-charts/BarChart';
import { PieChart } from '@mui/x-charts/PieChart';
import { LinePlot, MarkPlot } from '@mui/x-charts/LineChart';
import { ChartsContainer } from '@mui/x-charts/ChartsContainer';
import { ChartsXAxis } from '@mui/x-charts/ChartsXAxis';
import { ChartsYAxis } from '@mui/x-charts/ChartsYAxis';
import { ChartsTooltip } from '@mui/x-charts/ChartsTooltip';
import { ChartsLegend } from '@mui/x-charts/ChartsLegend';

import type { DashboardMetrics } from '@/lib/types';

const HEIGHT = 320;

export function MonthlyChart({ data }: { data: DashboardMetrics['monthly'] }) {
  return (
    <BarChart
      height={HEIGHT}
      xAxis={[{ scaleType: 'band', data: data.map((d) => d.month), label: '月' }]}
      yAxis={[{ label: '件数' }]}
      series={[
        { data: data.map((d) => d.count), label: '件数', color: undefined },
      ]}
      margin={{ left: 16, right: 16 }}
    />
  );
}

export function StatusDonut({ data }: { data: DashboardMetrics['statusBreakdown'] }) {
  return (
    <PieChart
      height={HEIGHT}
      series={[
        {
          data: data.map((d, i) => ({ id: i, value: d.count, label: d.status })),
          innerRadius: 60,
          paddingAngle: 2,
          cornerRadius: 4,
        },
      ]}
    />
  );
}

export function ParetoChart({ data }: { data: DashboardMetrics['defectPareto'] }) {
  const theme = useTheme();
  const categories = data.map((d) => d.defectType);
  return (
    <Box sx={{ width: '100%' }}>
      <ChartsContainer
        height={HEIGHT}
        series={[
          {
            type: 'bar',
            data: data.map((d) => d.count),
            label: '件数',
            yAxisId: 'count',
            color: theme.palette.primary.main,
          },
          {
            type: 'line',
            data: data.map((d) => d.cumulativePct),
            label: '累積 %',
            yAxisId: 'pct',
            color: theme.palette.secondary.main,
          },
        ]}
        xAxis={[{ id: 'x', scaleType: 'band', data: categories }]}
        yAxis={[
          { id: 'count', scaleType: 'linear', position: 'left' },
          { id: 'pct', scaleType: 'linear', min: 0, max: 105, position: 'right' },
        ]}
        margin={{ left: 16, right: 16 }}
      >
        <BarPlot />
        <LinePlot />
        <MarkPlot />
        <ChartsXAxis axisId="x" />
        <ChartsYAxis axisId="count" />
        <ChartsYAxis axisId="pct" />
        <ChartsLegend />
        <ChartsTooltip />
      </ChartsContainer>
    </Box>
  );
}
