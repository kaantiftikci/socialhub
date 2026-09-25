// better-sqlite3-multiple-ciphers, better-sqlite3 ile API uyumlu (ek: PRAGMA cipher/key). Paketin kendi bildirimi
// NodeNext çözümlemesinde bulunamıyor; better-sqlite3 tiplerini yeniden kullan.
declare module 'better-sqlite3-multiple-ciphers' {
  import Database from 'better-sqlite3';
  export = Database;
}
