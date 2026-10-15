import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { AuthUser, CurrentUser } from '../common/decorators/current-user.decorator';
import { ZodBody } from '../common/pipes/zod-validation.pipe';
import { CategoriesService } from './categories.service';
import { createCategorySchema, CreateCategoryDto, updateCategorySchema, UpdateCategoryDto } from './categories.dto';
import { Help } from '../sharing/help';

@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Help('any')
  @Get()
  list(@CurrentUser() user: AuthUser, @Query('type') type?: string, @Query('archived') archived?: string) {
    const t = type === 'INCOME' || type === 'EXPENSE' ? type : undefined;
    return this.categories.list(user.userId, t, archived === 'true');
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodBody(createCategorySchema)) dto: CreateCategoryDto) {
    return this.categories.create(user.userId, dto);
  }

  @Post('restore-defaults')
  @HttpCode(200)
  restore(@CurrentUser() user: AuthUser) {
    return this.categories.restoreDefaults(user.userId);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodBody(updateCategorySchema)) dto: UpdateCategoryDto) {
    return this.categories.update(user.userId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('moveTo') moveTo?: string) {
    return this.categories.remove(user.userId, id, moveTo || undefined);
  }
}
