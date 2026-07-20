// A fake server: real latency, stable data, a request counter you can watch
// in the console to see dedupe/staleness doing their job.

export interface Book {
  id: string
  title: string
  author: string
  written: number
}

const LIBRARY: Book[] = [
  { id: 'b01', title: 'Pride and Prejudice', author: 'Jane Austen', written: 1813 },
  { id: 'b02', title: 'Emma', author: 'Jane Austen', written: 1815 },
  { id: 'b03', title: 'Persuasion', author: 'Jane Austen', written: 1817 },
  { id: 'b04', title: 'War and Peace', author: 'Leo Tolstoy', written: 1869 },
  { id: 'b05', title: 'Anna Karenina', author: 'Leo Tolstoy', written: 1878 },
  { id: 'b06', title: 'Mrs Dalloway', author: 'Virginia Woolf', written: 1925 },
  { id: 'b07', title: 'To the Lighthouse', author: 'Virginia Woolf', written: 1927 },
  { id: 'b08', title: 'Animal Farm', author: 'George Orwell', written: 1945 },
  { id: 'b09', title: 'Nineteen Eighty-Four', author: 'George Orwell', written: 1949 },
  { id: 'b10', title: 'A Wizard of Earthsea', author: 'Ursula K. Le Guin', written: 1968 },
  { id: 'b11', title: 'The Dispossessed', author: 'Ursula K. Le Guin', written: 1974 },
  { id: 'b12', title: 'Kindred', author: 'Octavia E. Butler', written: 1979 },
  { id: 'b13', title: 'Beloved', author: 'Toni Morrison', written: 1987 },
  { id: 'b14', title: 'The Remains of the Day', author: 'Kazuo Ishiguro', written: 1989 },
  { id: 'b15', title: 'Never Let Me Go', author: 'Kazuo Ishiguro', written: 2005 },
]

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

let bookRequests = 0

/** Search by title or author. Empty query = the whole shelf. */
export async function fetchBooks(q: string): Promise<Book[]> {
  const n = ++bookRequests
  console.info(`[api] fetchBooks(${JSON.stringify(q)}) — request #${n}`)
  await sleep(600 + Math.random() * 300)
  const needle = q.trim().toLowerCase()
  return LIBRARY.filter(
    b => !needle || b.title.toLowerCase().includes(needle) || b.author.toLowerCase().includes(needle),
  )
}

const GIFTS: Omit<Book, 'id'>[] = [
  { title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin', written: 1969 },
  { title: 'Middlemarch', author: 'George Eliot', written: 1871 },
  { title: 'Jane Eyre', author: 'Charlotte Brontë', written: 1847 },
  { title: 'The Master and Margarita', author: 'Mikhail Bulgakov', written: 1967 },
]
let donations = 0

/** Donate the next gift book to the library — a real server WRITE. */
export async function donateBook(): Promise<Book> {
  const gift = GIFTS[donations % GIFTS.length]!
  donations++
  console.info(`[api] donateBook(${JSON.stringify(gift.title)})`)
  await sleep(800)
  const book = { id: `gift-${donations}`, ...gift }
  LIBRARY.push(book)
  return book
}

export interface ServerTodo {
  id: string
  title: string
  done: boolean
}

/** The "server's" todo list — slow on purpose so exhaust is feelable. */
export async function pullTodos(): Promise<ServerTodo[]> {
  console.info('[api] pullTodos()')
  await sleep(1400)
  return [
    { id: 'srv-1', title: 'Water the plants', done: false },
    { id: 'srv-2', title: 'Read Persuasion', done: false },
    { id: 'srv-3', title: 'Ship the tambour query spike', done: false },
  ]
}
