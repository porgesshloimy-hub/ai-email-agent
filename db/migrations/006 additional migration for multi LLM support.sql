-- Migration 006: Add multi-LLM providers to usage_service

ALTER TYPE usage_service
  ADD VALUE IF NOT EXISTS 'anthropic';

ALTER TYPE usage_service
  ADD VALUE IF NOT EXISTS 'mistral';