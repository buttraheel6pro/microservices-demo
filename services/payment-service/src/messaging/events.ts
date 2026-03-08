export const Events = {
  ORDER_CREATED: 'order.created',
  ORDER_COMPLETED: 'order.completed',
  ORDER_CANCELLED: 'order.cancelled',
  INVENTORY_RESERVED: 'inventory.reserved',
  INVENTORY_RELEASED: 'inventory.released',
  INVENTORY_FAILED: 'inventory.failed',
  PAYMENT_SUCCESS: 'payment.success',
  PAYMENT_FAILED: 'payment.failed',
} as const;

export type EventType = (typeof Events)[keyof typeof Events];

export interface BaseEvent<T = unknown> {
  eventType: EventType;
  timestamp: string;
  payload: T;
}

export interface InventoryReservedPayload {
  orderId: string;
  productId: string;
  quantity: number;
  amount: number;
}

export interface PaymentSuccessPayload {
  orderId: string;
  paymentId: string;
  amount: number;
}

export interface PaymentFailedPayload {
  orderId: string;
  paymentId: string;
  amount: number;
  reason: string;
}
