import { IsNumber, Max, Min } from 'class-validator';

export class UpdateAdvancedAiControlsDto {
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.6)
  @Max(0.7)
  executionConfidenceFloor: number;
}
