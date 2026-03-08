import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding inventory...');

  await prisma.inventory.upsert({
    where: { productId: 'p1' },
    update: {},
    create: {
      productId: 'p1',
      availableStock: 10,
      reservedStock: 0,
    },
  });

  await prisma.inventory.upsert({
    where: { productId: 'p2' },
    update: {},
    create: {
      productId: 'p2',
      availableStock: 5,
      reservedStock: 0,
    },
  });

  console.log('Seed complete');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
