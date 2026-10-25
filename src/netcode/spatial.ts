export interface Point { x: number; y: number }
/** Server-side visibility candidate lookup. Apply authorization/room filters before serializing entities. */
export class SpatialGrid<Id extends string | number> {
  private items = new Map<Id, Point & { key: string }>();
  private cells = new Map<string, Set<Id>>();
  constructor(readonly cellSize = 32, readonly maxEntities = 10000) {
    if (!(cellSize > 0) || !Number.isFinite(cellSize)) throw new RangeError('Invalid cell size');
  }
  private validate(p: Point) { if (![p.x, p.y].every(v => Number.isFinite(v) && Math.abs(v) <= 1e8)) throw new RangeError('Invalid position'); }
  upsert(id: Id, p: Point) {
    this.validate(p);
    if (!this.items.has(id) && this.items.size >= this.maxEntities) throw new Error('Spatial entity limit');
    const key = `${Math.floor(p.x / this.cellSize)},${Math.floor(p.y / this.cellSize)}`;
    const old = this.items.get(id);
    if (old && old.key !== key) { const c = this.cells.get(old.key)!; c.delete(id); if (!c.size) this.cells.delete(old.key); }
    let c = this.cells.get(key); if (!c) this.cells.set(key, c = new Set()); c.add(id);
    this.items.set(id, { ...p, key });
  }
  remove(id: Id): void {
    const p = this.items.get(id); if (!p) return;
    this.items.delete(id); const c = this.cells.get(p.key)!; c.delete(id); if (!c.size) this.cells.delete(p.key);
  }
  query(center: Point, radius: number): Set<Id> {
    this.validate(center);
    if (!Number.isFinite(radius) || radius < 0) throw new RangeError('Invalid radius');
    const minX = Math.floor((center.x - radius) / this.cellSize), maxX = Math.floor((center.x + radius) / this.cellSize);
    const minY = Math.floor((center.y - radius) / this.cellSize), maxY = Math.floor((center.y + radius) / this.cellSize);
    if ((maxX - minX + 1) * (maxY - minY + 1) > 4096) throw new RangeError('Query exceeds cell budget');
    const found = new Set<Id>(), r2 = radius * radius;
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) {
      for (const id of this.cells.get(`${x},${y}`) ?? []) {
        const p = this.items.get(id)!; if ((p.x - center.x) ** 2 + (p.y - center.y) ** 2 <= r2) found.add(id);
      }
    }
    return found;
  }
}
