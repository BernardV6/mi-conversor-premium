# 🚀 Next.js 15 App Router QuickRef

### Server vs Client
- **Server (Default)**: Fetch data here. No `useEffect`.
- **Client**: Add `'use client';` at the top for interactivity.

### Navigation
- `import { useRouter } from 'next/navigation';`
- `const router = useRouter(); router.push('/dashboard');`

### Data Fetching
- `const data = await fetch('https://api...');` (Directly in Server Component)
