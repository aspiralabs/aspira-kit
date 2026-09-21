import { describe, expect, it } from 'vitest';
import { floatingPanelClassName } from './floating-panel-primitive.js';

describe('floatingPanelClassName', () => {
    it('stacks above the drawer content layer so panels inside a drawer are not clipped', () => {
        const z = Number(floatingPanelClassName.match(/z-\[(\d+)\]/)?.[1]);
        expect(z).toBeGreaterThan(100000000); // Drawer content is z-[100000000]
    });
});
