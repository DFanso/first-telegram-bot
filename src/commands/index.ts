import { Command } from '../types';
import { startCommand } from './start';
import { videosCommand } from './videos';

export const commands: Command[] = [
  startCommand,
  videosCommand
  // Add more commands here
]; 