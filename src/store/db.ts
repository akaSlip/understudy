import Dexie, { type Table } from 'dexie'
import type { Play } from '../types'

export interface MetaRow {
  key: string
  value: unknown
}

class UnderstudyDB extends Dexie {
  plays!: Table<Play, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('understudy')
    this.version(1).stores({
      plays: 'id, updatedAt, title',
      meta: 'key',
    })
  }
}

export const db = new UnderstudyDB()
