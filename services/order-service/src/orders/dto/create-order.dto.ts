import { IsString, IsInt, IsNumber, Min } from 'class-validator';

export class CreateOrderDto {
  @IsString()
  productId: string;

  @IsInt()
  @Min(1)
  quantity: number;

  @IsNumber()
  @Min(0.01)
  amount: number;
}
