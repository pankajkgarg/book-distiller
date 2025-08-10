import { createFileRoute } from '@tanstack/react-router';

import BookDistiller from '@/lib/pages/book-distiller';

export const Route = createFileRoute('/')({
  component: BookDistiller,
});
