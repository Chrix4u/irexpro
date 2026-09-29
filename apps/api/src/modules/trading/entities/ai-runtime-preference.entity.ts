import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'ai_runtime_preferences', schema: 'trading' })
export class AiRuntimePreference {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid', unique: true })
  @Index()
  userId: string;

  @Column({
    name: 'research_paper_confidence_floor',
    type: 'numeric',
    precision: 4,
    scale: 3,
    default: '0.600',
  })
  researchPaperConfidenceFloor: string;

  @Column({ name: 'revision', type: 'integer', default: 1 })
  revision: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
