import { sortModels, groupModels, topOnlineModel, CATEGORY_ORDER } from '../utils/models';

const m = (id, category, workers_online) => ({ id, name: id, category, workers_online });

describe('sortModels (v3.40.0: busiest first)', () => {
  it('sorts by worker count desc, ties keep catalog order', () => {
    const input = [m('a', 'chat', 1), m('b', 'chat', 9), m('c', 'chat', 1), m('d', 'chat', 0)];
    expect(sortModels(input).map((x) => x.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('treats missing counts as zero and never mutates the input', () => {
    const input = [m('a', 'chat', 2), { id: 'b', category: 'chat' }];
    const out = sortModels(input);
    expect(out.map((x) => x.id)).toEqual(['a', 'b']);
    expect(input[0].id).toBe('a');
  });
});

describe('groupModels (v3.40.0: category groups)', () => {
  it('orders groups by CATEGORY_ORDER with online first inside', () => {
    const input = [
      m('e1', 'embedding', 0),
      m('v1', 'vision', 3),
      m('c1', 'chat', 0),
      m('c2', 'chat', 5),
    ];
    const groups = groupModels(input);
    expect(groups.map((g) => g.category)).toEqual(['chat', 'vision', 'embedding']);
    expect(groups[0].items.map((x) => x.id)).toEqual(['c2', 'c1']);
    expect(CATEGORY_ORDER).toEqual(['chat', 'code', 'vision', 'embedding']);
  });
});

describe('topOnlineModel (v3.40.0: auto-switch target)', () => {
  it('returns the busiest online model or null', () => {
    expect(topOnlineModel([m('a', 'chat', 0), m('b', 'code', 4)])).toMatchObject({ id: 'b' });
    expect(topOnlineModel([m('a', 'chat', 0)])).toBeNull();
    expect(topOnlineModel([])).toBeNull();
  });
});
