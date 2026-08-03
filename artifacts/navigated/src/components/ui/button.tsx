import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';
import { cva, type VariantProps } from 'class-variance-authority';

// 쿠키런 킹덤 스타일 버튼 Variants
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-2xl text-sm font-bold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 ' +
  'crvk-button',
  {
    variants: {
      variant: {
        default: 'crvk-button bg-primary text-white',
        destructive: 'crvk-button-danger bg-rose-500 text-white',
        outline: 'crvk-button-secondary bg-purple-500/50 text-white border-white/50',
        secondary: 'crvk-button-secondary bg-purple-500 text-white',
        ghost: 'crvk-button-icon bg-transparent',
        link: 'text-cyan-300 underline-offset-4 hover:underline',
        // 쿠키런 킹덤 전용 variants
        crystal: 'crvk-button bg-cyan-500 text-white shadow-lg',
        'crystal-secondary': 'crvk-button-secondary bg-purple-500 text-white',
        'crystal-danger': 'crvk-button-danger bg-rose-500 text-white',
        'crystal-gold': 'crvk-button bg-amber-400 text-white',
      },
      size: {
        default: 'min-h-12 px-6 py-3 text-base',
        sm: 'min-h-10 rounded-xl px-4 text-sm',
        lg: 'min-h-14 rounded-2xl px-10 text-lg',
        xl: 'min-h-16 rounded-3xl px-12 text-xl',
        icon: 'h-10 w-10 rounded-full',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };