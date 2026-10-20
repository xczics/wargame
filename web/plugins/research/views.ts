// The research plugin's views assembled in the browser (src/shared/client-views.ts).
import type { ResearchState } from '../../../src/shared/api';
import { type ClientViewDef, defineClientView } from '../../../src/shared/client-views';
import type { ResearchCatalog } from '../../../src/shared/research';
import type { TreeData } from '../../../src/shared/ui';
import { researchCurrent, researchGraph, researchOptions, researchQueue, researchTree } from './tree';

type Get = Parameters<ClientViewDef['compute']>[0];
const inputs = (get: Get) =>
	[get.data<ResearchState>('research.state'), get.static<TreeData>('research.techs')?.data as ResearchCatalog | undefined] as const;
const needs = ['research.state'];

export const views = [
	defineClientView({ id: 'research.tree', needs, compute: (get) => researchTree(...inputs(get)) }),
	defineClientView({ id: 'research.queue', needs, compute: (get) => researchQueue(...inputs(get)) }),
	defineClientView({ id: 'research.current', needs, compute: (get) => researchCurrent(...inputs(get)) }),
	defineClientView({ id: 'research.options', needs, compute: (get) => researchOptions(...inputs(get)) }),
	defineClientView({ id: 'research.graph', needs, compute: (get) => researchGraph(...inputs(get)) }),
];
